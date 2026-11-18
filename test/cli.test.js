import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from '../src/cli.js';
import { createCredentialStore } from '../src/windows-credentials.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64');

async function cli(args, overrides = {}) {
  let stdout = '';
  let stderr = '';
  const code = await run(args, {
    env: {},
    credentials: { get: async () => undefined },
    output: { write: (value) => { stdout += value; } },
    errorOutput: { write: (value) => { stderr += value; } },
    ...overrides,
  });
  return { code, stdout, stderr };
}

test('help and input errors run before accessing credentials', async () => {
  const credentials = { get() { assert.fail('Unexpected credential lookup'); } };
  assert.match((await cli(['--help'], { credentials })).stdout, /Usage: orgen/);
  assert.match((await cli(['image', '--help'], { credentials })).stdout, /--background/);
  assert.match((await cli(['music', '--help'], { credentials })).stdout, /--full/);
  assert.match((await cli(['image', '--help'], { credentials })).stdout, /--prompt-file/);
  assert.match((await cli(['music', '--help'], { credentials })).stdout, /--json/);
  assert.match((await cli(['auth', '--help'], { credentials })).stdout, /auth <set\|clear\|status>/);
  for (const [args, expected] of [
    [['music', 'Tune', '--model', 'other', '-o', 'test.mp3'], /--model/],
    [['image', 'Fox', '--resolution', '4K', '-o', 'test'], /compatible model/],
    [['image', 'Fox', '--background', 'blue', '-o', 'test'], /auto, opaque, or transparent/],
    [['image', 'Fox', '--background', 'transparent', '-o', 'test.jpg'], /does not match/],
    [['music', 'Tune', '-o', 'test.wav'], /does not match/],
  ]) {
    const result = await cli(args, { credentials });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, expected);
  }
});

test('auth set and clear manage the stored key without printing it', async () => {
  let saved;
  const credentials = {
    async set(key) { saved = key; },
    async clear() { saved = undefined; },
  };
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = (enabled) => { input.isRaw = enabled; };
  const settingKey = cli(['auth', 'set'], { credentials, input });
  assert.equal(input.isRaw, true);
  input.write('test-secret\r');
  const result = await settingKey;
  assert.equal(result.code, 0);
  assert.equal(saved, 'test-secret');
  assert.equal(input.isRaw, false);
  assert.match(result.stderr, /OpenRouter API key:/);
  assert.doesNotMatch(result.stdout + result.stderr, /test-secret/);
  assert.equal((await cli(['auth', 'clear'], { credentials })).code, 0);
  assert.equal(saved, undefined);
  assert.match((await cli(['auth', 'set'], { credentials, input: { isTTY: false } })).stderr, /interactive terminal/);
  assert.equal((await cli(['auth', 'set', 'test-secret'], { credentials })).code, 1);
});

test('generation requires a key from the environment or the keychain', async () => {
  const result = await cli(['image', 'Fox', '-o', 'fox']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /orgen auth set/);
});

test('auth status follows generation precedence and reports only the source', async () => {
  const fetchImpl = () => assert.fail('Auth status must not make a network request');
  const fromEnvironment = await cli(['auth', 'status'], {
    env: { OPENROUTER_API_KEY: 'some-environment-key' },
    credentials: { get() { assert.fail('Unexpected keychain lookup'); } },
    fetchImpl,
  });
  assert.deepEqual(fromEnvironment, {
    code: 0, stdout: 'OpenRouter API key source: OPENROUTER_API_KEY\n', stderr: '',
  });
  const fromKeychain = await cli(['auth', 'status'], {
    env: { OPENROUTER_API_KEY: ' ' },
    credentials: { get: async () => 'some-saved-key' },
    fetchImpl,
  });
  assert.deepEqual(fromKeychain, {
    code: 0, stdout: 'OpenRouter API key source: Windows Credential Manager\n', stderr: '',
  });
  const missing = await cli(['auth', 'status'], { fetchImpl });
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /API key missing/);
  const unavailable = await cli(['auth', 'status'], {
    credentials: { async get() { throw new Error('Could not access Windows Credential Manager.'); } },
    fetchImpl,
  });
  assert.equal(unavailable.code, 1);
  assert.equal(unavailable.stdout, '');
  assert.match(unavailable.stderr, /Could not access Windows Credential Manager/);
});

test('CLI saves the returned bytes atomically and uses the requested credential source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orgen-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'assets');
  const imageResponse = (cost) => Response.json({
    data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }],
    usage: cost === undefined ? undefined : { cost },
  });

  const output = join(folder, 'fox');
  const first = await cli(['image', 'Fox', '-o', output], {
    env: { OPENROUTER_API_KEY: 'env-key' },
    credentials: { get() { assert.fail('Environment key should take precedence'); } },
    async fetchImpl(_url, options) {
      assert.equal(options.headers.Authorization, 'Bearer env-key');
      return imageResponse(0.0035);
    },
  });
  assert.deepEqual(first, { code: 0, stdout: output + '.png\n', stderr: 'Cost: $0.0035\n' });
  assert.deepEqual(await readFile(output + '.png'), png);

  const next = await cli(['image', 'Bear', '--output', join(folder, 'bear.png')], {
    credentials: { get: async () => 'stored-key' },
    async fetchImpl(_url, options) {
      assert.equal(options.headers.Authorization, 'Bearer stored-key');
      return imageResponse();
    },
  });
  assert.equal(next.code, 0);
  assert.equal(next.stderr, 'Cost: unavailable\n');

  const existing = await cli(['image', 'Fox', '-o', output + '.png'], {
    credentials: { get() { assert.fail('Existing output should fail before generation'); } },
  });
  assert.match(existing.stderr, /already exists/);

  const mismatch = await cli(['image', 'Fox', '-o', join(folder, 'wrong.jpg')], {
    env: { OPENROUTER_API_KEY: 'env-key' }, fetchImpl: async () => imageResponse(),
  });
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /does not match/);

  const contenders = await Promise.all([1, 2].map(() => cli(['image', 'Fox', '-o', join(folder, 'race')], {
    env: { OPENROUTER_API_KEY: 'env-key' }, fetchImpl: async () => imageResponse(),
  })));
  assert.deepEqual(contenders.map(({ code }) => code).sort(), [0, 1]);
  assert.match(contenders.find(({ code }) => code === 1).stderr, /already exists/);
  assert.deepEqual((await readdir(folder)).sort(), ['bear.png', 'fox.png', 'race.png']);
});

test('music --full prints the saved path and reports the final cost, including zero', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orgen-music-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mp3 = Buffer.alloc(417);
  mp3.writeUInt32BE(0xfffb9064);
  const path = join(root, 'theme');
  const result = await cli(['music', 'Cinematic piano', '--full', '-o', path], {
    credentials: { get: async () => 'stored-key' },
    async fetchImpl(_url, options) {
      assert.equal(JSON.parse(options.body).model, 'google/lyria-3-pro-preview');
      const event = { choices: [{ delta: { audio: { data: mp3.toString('base64') } } }] };
      return new Response(
        `data: ${JSON.stringify(event)}\n\ndata: {"choices":[],"usage":{"cost":0}}\n\ndata: [DONE]\n\n`,
      );
    },
  });
  assert.deepEqual(result, { code: 0, stdout: path + '.mp3\n', stderr: 'Cost: $0.00\n' });
  assert.deepEqual(await readFile(path + '.mp3'), mp3);
});

test('music recitation appears in stderr and in batch JSON without saving audio', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orgen-music-blocked-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'loop.mp3');
  const manifest = join(root, 'jobs.json');
  await writeFile(manifest, JSON.stringify([{ prompt: 'Piano', output }]));
  const options = {
    env: { OPENROUTER_API_KEY: 'test-key' },
    fetchImpl: async () => new Response(
      'data: {"choices":[{"finish_reason":"content_filter","native_finish_reason":"RECITATION"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ),
  };

  const single = await cli(['music', 'Piano', '-o', output], options);
  assert.equal(single.code, 1);
  assert.equal(single.stdout, '');
  assert.match(single.stderr, /^orgen: OpenRouter audio generation failed\. \[RECITATION\]/);

  const batch = await cli(['music', '--batch', manifest, '--json'], options);
  assert.equal(batch.code, 1);
  const [failed] = JSON.parse(batch.stdout).results;
  assert.match(failed.error, /\[RECITATION\]/);
  assert.equal(failed.path, undefined);
  assert.deepEqual(await readdir(root), ['jobs.json']);
});

test('image and music accept multiline prompt files and emit a single JSON result', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orgen-prompts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const promptFile = join(root, 'asset prompt.txt');
  const prompt = 'Make it atmospheric.\r\nMood: café at sunrise.\r\n';
  await writeFile(promptFile, '\uFEFF' + prompt);
  const credentials = { get: async () => 'stored-key' };

  const imagePath = join(root, 'fox.png');
  const image = await cli(['image', '--prompt-file', promptFile, '--json', '-o', imagePath], {
    credentials,
    async fetchImpl(_url, options) {
      assert.equal(JSON.parse(options.body).prompt, prompt);
      return Response.json({
        data: [{ b64_json: png.toString('base64') }],
        usage: { cost: 0.035 },
      });
    },
  });
  assert.equal(image.code, 0, image.stderr);
  assert.equal(image.stderr, '');
  assert.deepEqual(JSON.parse(image.stdout), {
    path: imagePath, model: 'bytedance-seed/seedream-5-5', costUsd: 0.035,
  });
  assert.deepEqual(await readFile(imagePath), png);

  const mp3 = Buffer.alloc(417);
  mp3.writeUInt32BE(0xfffb9064);
  const musicPath = join(root, 'loop.mp3');
  const music = await cli(['music', '--prompt-file', promptFile, '--json', '-o', musicPath], {
    credentials,
    async fetchImpl(_url, options) {
      assert.equal(JSON.parse(options.body).messages[0].content, prompt);
      const event = {
        model: 'google/lyria-3-clip-preview-20260330',
        choices: [{ delta: { audio: { data: mp3.toString('base64') } } }],
      };
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    },
  });
  assert.equal(music.code, 0, music.stderr);
  assert.equal(music.stderr, '');
  assert.deepEqual(JSON.parse(music.stdout), {
    path: musicPath, model: 'google/lyria-3-clip-preview-20260330', costUsd: null,
  });
  assert.deepEqual(await readFile(musicPath), mp3);
});

test('prompt-file errors leave JSON stdout empty and fail before generation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orgen-empty-prompt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const empty = join(root, 'empty.txt');
  await writeFile(empty, ' \n\t');
  const credentials = { get() { assert.fail('Unexpected credential lookup'); } };
  for (const [args, expected] of [
    [['Fox', '--prompt-file', empty], /either a text prompt or --prompt-file/],
    [['--prompt-file', empty], /prompt file is empty/],
    [['--prompt-file', join(root, 'missing.txt')], /missing\.txt/],
    [[], /Provide exactly one quoted text prompt/],
  ]) {
    const result = await cli(['image', '--json', '-o', join(root, 'fox.png'), ...args], { credentials });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, expected);
  }
  assert.deepEqual(await readdir(root), ['empty.txt']);
});

test('omitted outputs are generated in the working directory for image and music', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orgen-default-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  await writeFile(join(root, 'fox.txt'), 'Winter fox');
  await writeFile(join(root, 'reference.png'), png);
  await writeFile(join(root, 'tracks.json'), JSON.stringify([{ prompt: 'Piano loop' }, { prompt: 'Quiet strings' }]));

  const mp3 = Buffer.alloc(417);
  mp3.writeUInt32BE(0xfffb9064);
  const mockPath = join(root, 'mock.mjs');
  await writeFile(mockPath, `
    import assert from 'node:assert/strict';
    globalThis.fetch = async (url, { body }) => {
      const request = JSON.parse(body);
      if (url.endsWith('/images')) {
        assert.equal(request.prompt, 'Winter fox');
        assert.equal(request.input_references[0].image_url.url, 'data:image/png;base64,${png.toString('base64')}');
        return Response.json({ data: [{ b64_json: '${png.toString('base64')}' }] });
      }
      assert.equal(request.model, 'google/lyria-3-pro-preview');
      const audio = { data: '${mp3.toString('base64')}' };
      const chunk = { choices: [{ delta: { audio } }], usage: { cost: 0.08 } };
      return new Response('data: ' + JSON.stringify(chunk) + '\\n\\ndata: [DONE]\\n\\n');
    };
  `);
  const executable = fileURLToPath(new URL('../bin/orgen.js', import.meta.url));
  const stdoutPath = join(root, 'stdout');
  const stderrPath = join(root, 'stderr');
  async function invoke(args) {
    await using stdoutFile = await open(stdoutPath, 'w');
    await using stderrFile = await open(stderrPath, 'w');
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(mockPath).href, executable, ...args], {
      cwd,
      env: { ...process.env, OPENROUTER_API_KEY: 'test-key' },
      stdio: ['ignore', stdoutFile.fd, stderrFile.fd],
      timeout: 5_000,
    });
    if (child.error) throw child.error;
    const stderr = await readFile(stderrPath, 'utf8');
    assert.equal(child.status, 0, stderr);
    return { stdout: await readFile(stdoutPath, 'utf8'), stderr };
  }

  const image = await invoke(['image', '--prompt-file', '../fox.txt', '--reference', '../reference.png', '--json']);
  const imagePath = JSON.parse(image.stdout).path;
  assert.equal(dirname(imagePath), cwd);
  assert.match(basename(imagePath), /^image-[a-f\d-]{36}\.png$/);
  assert.deepEqual(await readFile(imagePath), png);
  assert.equal(image.stderr, '');

  const music = await invoke(['music', '--batch', '../tracks.json', '--full']);
  const paths = music.stdout.trim().split('\n');
  assert.equal(new Set(paths).size, 2);
  for (const path of paths) {
    assert.equal(dirname(path), cwd);
    assert.match(basename(path), /^music-[a-f\d-]{36}\.mp3$/);
    assert.deepEqual(await readFile(path), mp3);
  }
  assert.match(music.stderr, /Job 1 cost: \$0\.08\nJob 2 cost: \$0\.08\nBatch: 2 saved, 0 failed\. Known cost: \$0\.16\./);
});

test('JSON batches keep successful outputs, continue after failures, and report known costs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orgen-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = join(root, 'jobs.json');
  const promptFile = join(root, 'bear.txt');
  const fox = join(root, 'assets', 'fox.png');
  const rejected = join(root, 'rejected.png');
  const bear = join(root, 'assets', 'bear');
  const wrong = join(root, 'wrong.jpg');
  await writeFile(promptFile, 'Bear\n');
  await writeFile(manifest, JSON.stringify([
    { prompt: 'Fox', output: fox },
    { prompt: 'Rejected', output: rejected },
    { promptFile, output: bear },
    { prompt: 'Incorrect format', output: wrong },
    { prompt: 'Overwriting fox', output: fox },
  ]));

  const prompts = [];
  let credentialLookups = 0;
  const result = await cli(['image', '--batch', manifest, '--background', 'opaque', '--json'], {
    credentials: {
      async get() {
        credentialLookups += 1;
        return 'stored-key';
      },
    },
    async fetchImpl(_url, options) {
      const { prompt, background } = JSON.parse(options.body);
      prompts.push(prompt);
      assert.equal(background, 'opaque');
      if (prompt === 'Rejected') return Response.json({ error: { message: 'Provider failed' } }, { status: 502 });
      return Response.json({
        data: [{ b64_json: png.toString('base64') }],
        usage: { cost: { Fox: 0.02, 'Bear\n': 0.035, 'Incorrect format': 0.003 }[prompt] },
      });
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.equal(credentialLookups, 1);
  assert.deepEqual(prompts, ['Fox', 'Rejected', 'Bear\n', 'Incorrect format']);
  const { results, knownCostUsd } = JSON.parse(result.stdout);
  assert.equal(knownCostUsd, 0.058);
  assert.deepEqual(results.map(({ index, costUsd }) => [index, costUsd]), [
    [1, 0.02], [2, null], [3, 0.035], [4, 0.003], [5, null],
  ]);
  assert.equal(results[0].path, fox);
  assert.equal(results[2].path, bear + '.png');
  assert.equal(results[2].model, 'bytedance-seed/seedream-5-5');
  assert.match(results[1].error, /Provider failed/);
  assert.match(results[3].error, /does not match/);
  assert.match(results[4].error, /already exists/);
  assert.deepEqual(await readFile(fox), png);
  assert.deepEqual(await readFile(bear + '.png'), png);
  assert.deepEqual((await readdir(root)).sort(), ['assets', 'bear.txt', 'jobs.json']);
});

test('invalid batch inputs and reference files fail before credential lookup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orgen-batch-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = join(root, 'jobs.json');
  const credentials = { get() { assert.fail('Unexpected credential lookup'); } };
  for (const [contents, expected] of [
    ['[', /valid JSON/],
    ['[]', /nonempty JSON array/],
    [JSON.stringify([{ prompt: 'Start' }, { promptFile: join(root, 'missing.txt') }]), /Batch job 2.*missing\.txt/],
    [JSON.stringify([{ prompt: 'Starts valid' }, { prompt: 'Conflicting', promptFile: 'other.txt' }]), /Batch job 2.*either/],
  ]) {
    await writeFile(manifest, contents);
    const result = await cli(['image', '--batch', manifest, '--json'], { credentials });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, expected);
  }

  for (const argumentsToReject of [['Fox'], ['--prompt-file', 'fox.txt'], ['-o', 'fox.png']]) {
    const result = await cli(['image', '--batch', manifest, ...argumentsToReject], { credentials });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Set them in the manifest/);
  }
  const referencePath = join(root, 'invalid.png');
  await writeFile(referencePath, 'not an image');
  const reference = await cli(['image', 'Fox', '--reference', referencePath], { credentials });
  assert.equal(reference.code, 1);
  assert.match(reference.stderr, /reference image must be a PNG/);
});

test('Windows Credential Manager round trip', {
  skip: process.env.ORGEN_TEST_WINDOWS_KEYCHAIN !== '1',
}, async () => {
  const credentials = createCredentialStore({ target: `orgen/test/${randomUUID()}` });
  try {
    assert.equal(await credentials.get(), undefined);
    await credentials.set('first-test-value');
    assert.equal(await credentials.get(), 'first-test-value');
    await credentials.set('replacement-test-value');
    assert.equal(await credentials.get(), 'replacement-test-value');
  } finally {
    await credentials.clear();
  }
  assert.equal(await credentials.get(), undefined);
});
