import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
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
  assert.match((await cli(['auth', '--help'], { credentials })).stdout, /auth <set\|clear>/);
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

test('CLI saves the returned bytes atomically and uses the requested credential source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orgen-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'assets');
  const imageResponse = () => Response.json({ data: [
    { b64_json: png.toString('base64'), media_type: 'image/png' },
  ] });

  const output = join(folder, 'fox');
  const first = await cli(['image', 'Fox', '-o', output], {
    env: { OPENROUTER_API_KEY: 'env-key' },
    credentials: { get() { assert.fail('Environment key should take precedence'); } },
    async fetchImpl(_url, options) {
      assert.equal(options.headers.Authorization, 'Bearer env-key');
      return imageResponse();
    },
  });
  assert.deepEqual(first, { code: 0, stdout: output + '.png\n', stderr: '' });
  assert.deepEqual(await readFile(output + '.png'), png);

  const next = await cli(['image', 'Bear', '--output', join(folder, 'bear.png')], {
    credentials: { get: async () => 'stored-key' },
    async fetchImpl(_url, options) {
      assert.equal(options.headers.Authorization, 'Bearer stored-key');
      return imageResponse();
    },
  });
  assert.equal(next.code, 0);

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

test('music --full writes an MP3 and prints the saved path', async (t) => {
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
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    },
  });
  assert.deepEqual(result, { code: 0, stdout: path + '.mp3\n', stderr: '' });
  assert.deepEqual(await readFile(path + '.mp3'), mp3);
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
