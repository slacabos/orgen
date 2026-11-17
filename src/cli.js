import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { createClient, validateImageOptions } from './client.js';
import { mediaExtensions, referenceImageType } from './media.js';
import { createCredentialStore } from './windows-credentials.js';

const commonOptions = {
  help: { type: 'boolean', short: 'h' },
  output: { type: 'string', short: 'o' },
  json: { type: 'boolean' },
  'prompt-file': { type: 'string' },
  batch: { type: 'string' },
};
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 20,
});
const help = {
  main: `Usage: orgen <command> [options]

  image    Generate one image from text
  music    Generate an MP3 from text
  auth     Manage the saved OpenRouter API key

Run orgen <command> --help for options.`,
  image: `Usage: orgen image ("<prompt>" | --prompt-file <path> | --batch <path>) [options]

  -o, --output <path>    Destination for one image (default: generated name in current directory)
  --prompt-file <path>   Read the prompt from a UTF-8 file
  --batch <path>         Generate one image per job in a JSON manifest
  --json                 Print path, model, and cost as JSON
  --reference <path>     Guide generation with a PNG, JPEG, or WebP image
  --model <id>           OpenRouter image model (default: bytedance-seed/seedream-5-5)
  --aspect-ratio <ratio>  Aspect ratio, for example 16:9
  --resolution <tier>    1K, 1.5K, 2K, or 4K (4K requires a compatible --model)
  --background <mode>    auto, opaque, or transparent (PNG)
  -h, --help             Show command help`,
  music: `Usage: orgen music ("<prompt>" | --prompt-file <path> | --batch <path>) [options]

  -o, --output <path>    Destination for one MP3 (default: generated name in current directory)
  --prompt-file <path>   Read the prompt from a UTF-8 file
  --batch <path>         Generate one track per job in a JSON manifest
  --json                 Print path, model, and cost as JSON
  --full                 Generate a full track (default: 30-second clip)
  -h, --help             Show command help`,
  auth: `Usage: orgen auth <set|clear|status>

  set     Save or replace the OpenRouter API key in Windows Credential Manager
  clear   Remove the saved key
  status  Show which credential source orgen would use`,
};
const generationOptions = {
  image: {
    ...commonOptions,
    model: { type: 'string' },
    'aspect-ratio': { type: 'string' },
    resolution: { type: 'string' },
    background: { type: 'string' },
    reference: { type: 'string' },
  },
  music: { ...commonOptions, full: { type: 'boolean' } },
};

async function readPrompt(positionals, promptFile) {
  if (promptFile !== undefined) {
    if (positionals.length) throw new Error('Use either a text prompt or --prompt-file.');
    if (typeof promptFile !== 'string' || !promptFile.trim()) {
      throw new Error('Provide a prompt file path.');
    }
    const prompt = (await readFile(promptFile, 'utf8')).replace(/^\uFEFF/, '');
    if (!prompt.trim()) throw new Error('The prompt file is empty.');
    return prompt;
  }

  const [prompt] = positionals;
  if (positionals.length !== 1 || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Provide exactly one quoted text prompt or use --prompt-file.');
  }
  return prompt;
}

async function readBatch(path, command, background) {
  if (!path.trim()) throw new Error('Provide a manifest path with --batch.');
  const text = await readFile(path, 'utf8');
  let entries;
  try {
    entries = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('The batch manifest must contain valid JSON.');
  }
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error('The batch manifest must be a nonempty JSON array.');
  }

  const jobs = [];
  for (const [offset, entry] of entries.entries()) {
    try {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          Object.keys(entry).some((key) => !['prompt', 'promptFile', 'output'].includes(key))) {
        throw new Error('Use a job object with prompt or promptFile and an optional output.');
      }
      const prompt = await readPrompt(Object.hasOwn(entry, 'prompt') ? [entry.prompt] : [], entry.promptFile);
      jobs.push(prepareJob(command, prompt, entry.output, background));
    } catch (error) {
      throw new Error(`Batch job ${offset + 1}: ${error.message}`);
    }
  }
  return jobs;
}

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

function prepareJob(command, prompt, output, background) {
  if (output !== undefined &&
      (typeof output !== 'string' || !output.trim() || /[\\/]$/.test(output))) {
    throw new Error('Provide a valid output file path.');
  }
  const path = resolve(output ?? `${command}-${randomUUID()}`);
  let preflightPath;
  if (command === 'music') {
    preflightPath = pathForMedia(path, 'audio/mpeg');
  } else if (background === 'transparent') {
    preflightPath = pathForMedia(path, 'image/png');
  } else if (extname(path)) {
    preflightPath = path;
  }
  return { prompt, path, preflightPath };
}

async function checkOutputAvailable(path) {
  if (!path) return;
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

async function resolveCredential(env, credentials) {
  const override = env.OPENROUTER_API_KEY?.trim();
  if (override) return { key: override, source: 'OPENROUTER_API_KEY' };
  const stored = (await credentials.get())?.trim();
  if (stored) return { key: stored, source: 'Windows Credential Manager' };
  throw new Error('OpenRouter API key missing. Run orgen auth set or set OPENROUTER_API_KEY.');
}

function formatCost(costUsd) {
  return costUsd === null ? 'unavailable' : usd.format(costUsd);
}

async function generateAndSave(job, generate, recordCost) {
  const { bytes, mediaType, model, costUsd } = await generate(job.prompt);
  recordCost(costUsd);
  const path = pathForMedia(job.path, mediaType);
  await saveOutput(path, bytes);
  return { path, model, costUsd };
}

async function runBatch(jobs, generate, { json, output, errorOutput }) {
  const results = [];
  let failures = 0;
  for (const [offset, job] of jobs.entries()) {
    const index = offset + 1;
    let costUsd = null;
    try {
      await checkOutputAvailable(job.preflightPath);
      const result = await generateAndSave(job, generate, (cost) => {
        costUsd = cost;
        if (!json) errorOutput.write(`Job ${index} cost: ${formatCost(cost)}\n`);
      });
      results.push({ index, ...result });
      if (!json) output.write(result.path + '\n');
    } catch (error) {
      failures += 1;
      results.push({ index, error: error.message, costUsd });
      if (!json) errorOutput.write(`Job ${index}: ${error.message}\n`);
    }
  }
  // Remove floating-point addition noise before displaying the USD subtotal.
  const knownCostUsd = Number(results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0).toPrecision(15));
  if (json) {
    output.write(JSON.stringify({ results, knownCostUsd }) + '\n');
  } else {
    errorOutput.write(`Batch: ${jobs.length - failures} saved, ${failures} failed. Known cost: ${usd.format(knownCostUsd)}.\n`);
  }
  return failures ? 1 : 0;
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
      } else if (args.length === 1 && args[0] === 'status') {
        const { source } = await resolveCredential(env, credentials);
        output.write(`OpenRouter API key source: ${source}\n`);
      } else {
        throw new Error('Use orgen auth set, clear, or status.');
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
    const batch = values.batch !== undefined;
    if (batch && (positionals.length || values['prompt-file'] !== undefined || values.output !== undefined)) {
      throw new Error('Use --batch by itself for prompts and output paths. Set them in the manifest.');
    }

    const imageOptions = {
      model: values.model,
      resolution: values.resolution,
      aspectRatio: values['aspect-ratio'],
      background: values.background,
    };
    if (command === 'image') {
      validateImageOptions(imageOptions);
      if (values.reference !== undefined) {
        if (!values.reference.trim()) throw new Error('Provide a file path with --reference.');
        imageOptions.referenceImage = await readFile(values.reference);
        referenceImageType(imageOptions.referenceImage);
      }
    }

    let jobs;
    if (batch) {
      jobs = await readBatch(values.batch, command, values.background);
    } else {
      const prompt = await readPrompt(positionals, values['prompt-file']);
      const job = prepareJob(command, prompt, values.output, values.background);
      await checkOutputAvailable(job.preflightPath);
      jobs = [job];
    }
    const { key } = await resolveCredential(env, credentials);
    const client = createClient({ apiKey: key, fetchImpl });
    const generate = command === 'image'
      ? (prompt) => client.generateImage({ prompt, ...imageOptions })
      : (prompt) => client.generateMusic({ prompt, full: values.full });
    if (batch) {
      return await runBatch(jobs, generate, { json: values.json, output, errorOutput });
    }

    const result = await generateAndSave(jobs[0], generate, (cost) => {
      if (!values.json) errorOutput.write(`Cost: ${formatCost(cost)}\n`);
    });
    output.write((values.json ? JSON.stringify(result) : result.path) + '\n');
    return 0;
  } catch (error) {
    errorOutput.write(`orgen: ${error.message}\n`);
    return 1;
  }
}
