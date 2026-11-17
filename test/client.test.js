import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '../src/client.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64');
const mp3 = Buffer.alloc(417);
mp3.writeUInt32BE(0xfffb9064);

function audioEvent(data) {
  const chunk = { choices: [{ delta: { audio: { data } } }] };
  return `data: ${JSON.stringify(chunk)}\r\n\r\n`;
}

function streamResponse(...chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('images send Seedream options and request one PNG for transparency', async () => {
  const client = createClient({
    apiKey: 'test-key',
    async fetchImpl(url, options) {
      assert.equal(url, 'https://openrouter.ai/api/v1/images');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      assert.deepEqual(JSON.parse(options.body), {
        model: 'bytedance-seed/seedream-5-5',
        prompt: 'Fox',
        n: 1,
        aspect_ratio: '1:1',
        resolution: '1.5K',
        background: 'transparent',
        output_format: 'png',
      });
      return Response.json({
        data: [{ b64_json: png.toString('base64') }],
        usage: { cost: 0.035 },
      });
    },
  });

  assert.deepEqual(await client.generateImage({
    prompt: 'Fox', aspectRatio: '1:1', resolution: '1.5K', background: 'transparent',
  }), { bytes: png, mediaType: 'image/png', model: 'bytedance-seed/seedream-5-5', costUsd: 0.035 });
});

test('4K requires an explicit compatible image model', async () => {
  const client = createClient({
    apiKey: 'test-key',
    async fetchImpl(_url, options) {
      assert.deepEqual(JSON.parse(options.body), {
        model: 'sourceful/riverflow-v2.6-pro', prompt: 'Landscape', n: 1, resolution: '4K',
      });
      return Response.json({ data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }] });
    },
  });
  await assert.rejects(client.generateImage({ prompt: 'Landscape', resolution: '4K' }), /compatible model/);
  await client.generateImage({
    prompt: 'Landscape', resolution: '4K', model: 'sourceful/riverflow-v2.6-pro',
  });
});

test('image errors and invalid media are actionable and do not expose the API key', async () => {
  const apiKey = 'test-key';
  for (const [response, expected] of [
    [Response.json({ error: { message: `Invalid credential ${apiKey}` } }, { status: 401 }), /HTTP 401.*\[redacted\]/],
    [Response.json({ data: [{ b64_json: '???' }] }), /invalid base64/],
    [Response.json({ data: [{ b64_json: 'aGVsbG8=', media_type: 'image/png' }] }), /do not match/],
    [Response.json({ data: [] }), /no image data/],
  ]) {
    const client = createClient({ apiKey, fetchImpl: async () => response });
    await assert.rejects(client.generateImage({ prompt: 'Fox' }), (error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /test-key/);
      return true;
    });
  }
});

test('both music modes decode base64 fragments split across SSE events and transport chunks', async () => {
  const base64 = mp3.toString('base64');
  const events = ': OPENROUTER PROCESSING\r\n\r\n' +
    audioEvent(base64.slice(0, 5)) + audioEvent(base64.slice(5)) +
    'data: {"choices":[],"usage":{"cost":0.04}}\r\n\r\ndata: [DONE]\r\n\r\n';
  const models = ['google/lyria-3-clip-preview', 'google/lyria-3-pro-preview'];
  const client = createClient({
    apiKey: 'test-key',
    async fetchImpl(url, options) {
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.deepEqual(JSON.parse(options.body), {
        model: models.shift(),
        messages: [{ role: 'user', content: 'Piano' }],
        modalities: ['text', 'audio'],
        audio: { format: 'mp3' },
        stream: true,
      });
      return streamResponse(...events.match(/[\s\S]{1,13}/g));
    },
  });
  const expected = { bytes: mp3, mediaType: 'audio/mpeg', costUsd: 0.04 };
  assert.deepEqual(await client.generateMusic({ prompt: 'Piano' }), {
    ...expected, model: 'google/lyria-3-clip-preview',
  });
  assert.deepEqual(await client.generateMusic({ prompt: 'Piano', full: true }), {
    ...expected, model: 'google/lyria-3-pro-preview',
  });
});

test('music rejects truncated, failed, and invalid audio streams', async () => {
  for (const [response, expected] of [
    [streamResponse(audioEvent(mp3.toString('base64'))), /ended before completion/],
    [streamResponse('data: {"error":{"message":"Provider disconnected"}}\n\n'), /Provider disconnected/],
    [streamResponse(audioEvent('aGVsbG8='), 'data: [DONE]\n\n'), /invalid MP3/],
    [streamResponse('data: [DONE]\n\n'), /no audio data/],
  ]) {
    const client = createClient({ apiKey: 'test-key', fetchImpl: async () => response });
    await assert.rejects(client.generateMusic({ prompt: 'Piano' }), expected);
  }
});
