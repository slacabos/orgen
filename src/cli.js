import { link, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { createClient, validateImageOptions } from './client.js';
import { mediaExtensions } from './media.js';
import { createCredentialStore } from './windows-credentials.js';

const helpOption = { type: 'boolean', short: 'h' };
const outputOption = { type: 'string', short: 'o' };
const help = {
  main: `Usage: orgen <command> [options]

  image    Generate one image from text
  music    Generate an MP3 from text
  auth     Manage the saved OpenRouter API key

Run orgen <command> --help for options.`,
  image: `Usage: orgen image "<prompt>" -o <path> [options]

  -o, --output <path>     Destination path
  --model <id>           OpenRouter image model (default: bytedance-seed/seedream-5-5)
  --aspect-ratio <ratio> Aspect ratio, for example 16:9
  --resolution <tier>    1K, 1.5K, 2K, or 4K (4K requires a compatible --model)
  --background <mode>    auto, opaque, or transparent (PNG)
  -h, --help             Show command help`,
  music: `Usage: orgen music "<prompt>" -o <path> [options]

  -o, --output <path>     Destination path for the MP3
  --full                 Generate a full track (default: 30-second clip)
  -h, --help             Show command help`,
  auth: `Usage: orgen auth <set|clear>

  set    Save or replace the OpenRouter API key in Windows Credential Manager
  clear  Remove the saved key`,
};
const generationOptions = {
  image: {
    help: helpOption,
    output: outputOption,
    model: { type: 'string' },
    'aspect-ratio': { type: 'string' },
    resolution: { type: 'string' },
    background: { type: 'string' },
  },
  music: { help: helpOption, output: outputOption, full: { type: 'boolean' } },
};

async function promptForKey(input, output) {
  if (!input.isTTY) throw new Error('Run orgen auth set in an interactive terminal.');
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const readline = createInterface({ input, output: muted, terminal: true });
  const controller = new AbortController();
  readline.once('SIGINT', () => controller.abort());
  readline.once('close', () => controller.abort());
  output.write('OpenRouter API key: ');
  try {
    return (await readline.question('', { signal: controller.signal })).trim();
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Key setup cancelled.');
    throw error;
  } finally {
    readline.close();
    output.write('\n');
  }
}

function pathForMedia(path, mediaType) {
  const allowed = mediaExtensions(mediaType);
  const extension = extname(path);
  if (extension && !allowed.includes(extension.toLowerCase())) {
    throw new Error(`Output extension ${extension} does not match ${mediaType}. Use ${allowed.join(' or ')}.`);
  }
  return extension ? path : path + allowed[0];
}

async function checkOutputAvailable(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Output already exists: ${path}`);
}

async function saveOutput(path, bytes) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tempDir = await mkdtemp(join(parent, '.orgen-'));
  try {
    const tempFile = join(tempDir, 'asset');
    await writeFile(tempFile, bytes);
    // Linking a completed file installs it atomically and fails if the destination exists.
    await link(tempFile, path);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Output already exists: ${path}`);
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function run(argv, {
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  credentials = createCredentialStore(),
  fetchImpl,
  readKey = () => promptForKey(input, errorOutput),
} = {}) {
  const [command, ...args] = argv;
  try {
    if (!command || ['-h', '--help'].includes(command)) {
      output.write(help.main + '\n');
      return 0;
    }
    if (command === 'auth') {
      if (!args.length || (args.length === 1 && ['-h', '--help'].includes(args[0]))) {
        output.write(help.auth + '\n');
      } else if (args.length === 1 && args[0] === 'set') {
        const key = await readKey();
        if (!key || /[^!-~]/.test(key)) throw new Error('Enter a nonempty OpenRouter key without spaces.');
        await credentials.set(key);
        output.write('OpenRouter API key saved.\n');
      } else if (args.length === 1 && args[0] === 'clear') {
        await credentials.clear();
        output.write('Saved OpenRouter API key removed.\n');
      } else {
        throw new Error('Use orgen auth set or orgen auth clear.');
      }
      return 0;
    }
    if (!Object.hasOwn(generationOptions, command)) {
      throw new Error('Unknown command. Run orgen --help.');
    }

    const { values, positionals } = parseArgs({
      args, options: generationOptions[command], allowPositionals: true,
    });
    if (values.help) {
      output.write(help[command] + '\n');
      return 0;
    }
    const [prompt] = positionals;
    if (positionals.length !== 1 || !prompt.trim()) {
      throw new Error('Provide exactly one quoted text prompt.');
    }
    if (!values.output?.trim() || /[\\/]$/.test(values.output)) {
      throw new Error('Provide a file path with -o or --output.');
    }

    const imageOptions = {
      model: values.model,
      resolution: values.resolution,
      aspectRatio: values['aspect-ratio'],
      background: values.background,
    };
    if (command === 'image') validateImageOptions(imageOptions);

    const path = resolve(values.output);
    if (command === 'music') {
      await checkOutputAvailable(pathForMedia(path, 'audio/mpeg'));
    } else if (imageOptions.background === 'transparent') {
      await checkOutputAvailable(pathForMedia(path, 'image/png'));
    } else if (extname(path)) {
      await checkOutputAvailable(path);
    }

    const key = env.OPENROUTER_API_KEY?.trim() || (await credentials.get())?.trim();
    if (!key) throw new Error('OpenRouter API key missing. Run orgen auth set or set OPENROUTER_API_KEY.');
    const client = createClient({ apiKey: key, fetchImpl });
    const { bytes, mediaType } = command === 'image'
      ? await client.generateImage({ prompt, ...imageOptions })
      : await client.generateMusic({ prompt, full: values.full });
    const destination = pathForMedia(path, mediaType);
    await saveOutput(destination, bytes);
    output.write(destination + '\n');
    return 0;
  } catch (error) {
    errorOutput.write(`orgen: ${error.message}\n`);
    return 1;
  }
}
