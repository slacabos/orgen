import { decodeBase64, imageMediaType, validateMp3 } from './media.js';

const apiUrl = 'https://openrouter.ai/api/v1';
const defaultImageModel = 'bytedance-seed/seedream-5-5';
const clipModel = 'google/lyria-3-clip-preview';
const fullModel = 'google/lyria-3-pro-preview';

export function validateImageOptions({ model = defaultImageModel, resolution, background }) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('Specify an image model ID.');
  if (resolution !== undefined && !['1K', '1.5K', '2K', '4K'].includes(resolution)) {
    throw new Error('Resolution must be 1K, 1.5K, 2K, or 4K.');
  }
  if (resolution === '4K' && model === defaultImageModel) {
    throw new Error('For 4K, specify a compatible model, such as sourceful/riverflow-v2.6-pro.');
  }
  if (background !== undefined && !['auto', 'opaque', 'transparent'].includes(background)) {
    throw new Error('Background must be auto, opaque, or transparent.');
  }
}

function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Provide a text prompt.');
}

function providerError(message, apiKey) {
  if (typeof message !== 'string') return '';
  return message.replaceAll(apiKey, '[redacted]')
    .replace(/[A-Za-z0-9+/=_-]{64,}/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, 300);
}

async function* sseData(body) {
  if (!body) throw new Error('OpenRouter returned no audio stream.');
  let pending = '';
  let data = [];
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (line.startsWith('data:')) {
        data.push(line.slice(5).trim());
      } else if (line.trim() === '' && data.length) {
        yield data.join('\n');
        data = [];
      }
    }
  }
  if (pending.startsWith('data:')) data.push(pending.slice(5).trim());
  if (data.length) yield data.join('\n');
}

async function readMusic(response, apiKey) {
  const fragments = [];
  for await (const event of sseData(response.body)) {
    if (!event) continue;
    if (event === '[DONE]') {
      const bytes = decodeBase64(fragments.join(''), 'audio');
      validateMp3(bytes);
      return { bytes, mediaType: 'audio/mpeg' };
    }
    let chunk;
    try {
      chunk = JSON.parse(event);
    } catch {
      throw new Error('OpenRouter returned an invalid audio stream event.');
    }
    const choice = chunk?.choices?.[0];
    if (chunk?.error || choice?.error || choice?.finish_reason === 'error') {
      const message = providerError((chunk.error ?? choice?.error)?.message, apiKey);
      throw new Error(message ? `OpenRouter audio generation failed. ${message}` : 'OpenRouter audio generation failed.');
    }
    const fragment = choice?.delta?.audio?.data;
    if (typeof fragment === 'string') fragments.push(fragment);
  }
  throw new Error('The OpenRouter audio stream ended before completion.');
}

export function createClient({ apiKey, fetchImpl = fetch } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new Error('An OpenRouter API key is required.');

  async function request(endpoint, payload, readResponse) {
    const signal = AbortSignal.timeout(180_000);
    try {
      let response;
      try {
        response = await fetchImpl(`${apiUrl}/${endpoint}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          redirect: 'error',
          body: JSON.stringify(payload),
          signal,
        });
      } catch {
        throw new Error('Could not connect to OpenRouter.');
      }

      if (!response.ok) {
        const result = await response.json().catch(() => {});
        const message = providerError(result?.error?.message, key);
        throw new Error(`OpenRouter returned HTTP ${response.status}.${message ? ` ${message}` : ''}`);
      }
      return await readResponse(response);
    } catch (error) {
      if (signal.aborted) throw new Error('The OpenRouter request timed out after three minutes.');
      if (error instanceof TypeError) throw new Error('The OpenRouter connection closed before completion.');
      throw error;
    }
  }

  return {
    async generateImage({ prompt, model = defaultImageModel, aspectRatio, resolution, background }) {
      validatePrompt(prompt);
      validateImageOptions({ model, resolution, background });
      const transparent = background === 'transparent';
      return request('images', {
        model,
        prompt,
        n: 1,
        aspect_ratio: aspectRatio,
        resolution,
        background,
        output_format: transparent ? 'png' : undefined,
      }, async (response) => {
        const result = await response.json().catch(() => {
          throw new Error('OpenRouter returned an invalid image response.');
        });
        if (result?.error) {
          const message = providerError(result.error.message, key);
          throw new Error(message ? `OpenRouter image generation failed. ${message}` : 'OpenRouter image generation failed.');
        }
        const image = result?.data?.[0];
        const bytes = decodeBase64(image?.b64_json, 'image');
        return { bytes, mediaType: imageMediaType(bytes, image.media_type, transparent) };
      });
    },

    async generateMusic({ prompt, full = false }) {
      validatePrompt(prompt);
      return request('chat/completions', {
        model: full ? fullModel : clipModel,
        messages: [{ role: 'user', content: prompt }],
        modalities: ['text', 'audio'],
        audio: { format: 'mp3' },
        stream: true,
      }, (response) => readMusic(response, key));
    },
  };
}
