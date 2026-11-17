# orgen

Generate images and music from text prompts and save them in your project. You need Node.js 24+ and an [OpenRouter API key](https://openrouter.ai/settings/keys) with credits.

## Install and save your key

Run `npm link` from the `orgen` checkout. Then run `orgen auth set` in a Windows or WSL terminal. Paste your key at the hidden prompt and press Enter. It is saved in Windows Credential Manager for the current user under `orgen/openrouter`. Run `orgen auth set` again to replace it or `orgen auth clear` to remove it.

An exported `OPENROUTER_API_KEY` overrides the saved key for that process. You can also use the environment variable on other systems or when Windows interoperability is unavailable.

## Generate assets

Run these commands from the project that will use the assets.

```sh
orgen image "Misty mountain landscape at sunrise" --resolution 2K --aspect-ratio 16:9 -o assets/hero
orgen image "Watercolor fox icon" --background transparent -o assets/fox.png
orgen music "Upbeat instrumental synth loop, no vocals" -o assets/loop.mp3
orgen music "Cinematic piano and strings" --full -o assets/theme.mp3
```

- Images use [Seedream 5.5](https://openrouter.ai/api/v1/images/models/bytedance-seed/seedream-5-5/endpoints) by default. It supports `1K`, `1.5K`, and `2K` resolutions. Background modes are `auto`, `opaque`, and `transparent`. Transparent requests return PNG.
- Use an explicit compatible model for 4K. For example, add `--resolution 4K --model sourceful/riverflow-v2.6-pro` to the transparent fox command and choose a fresh output path. [Riverflow capabilities](https://openrouter.ai/api/v1/images/models/sourceful/riverflow-v2.6-pro/endpoints)
- Music defaults to a [30-second Lyria 3 Clip](https://openrouter.ai/google/lyria-3-clip-preview). `--full` generates a full track with [Lyria 3 Pro](https://openrouter.ai/google/lyria-3-pro-preview).
- Use `-o` or `--output` to choose the destination. For an image in the model's default format, omit the extension and let `orgen` add it. `orgen` creates missing directories, refuses to overwrite existing files, and prints the absolute path on success.

## Use from Node.js

Link the package into your other Node.js project with `npm link orgen`. The client returns a `Buffer` and its MIME type.

```js
import { createClient } from 'orgen';

const client = createClient({ apiKey: process.env.OPENROUTER_API_KEY });
const { bytes, mediaType } = await client.generateImage({
  prompt: 'Watercolor fox icon',
  background: 'transparent',
});
```

## Verify locally

- Run `npm test` for offline tests. From a regular WSL terminal, run `ORGEN_TEST_WINDOWS_KEYCHAIN=1 npm test` to also verify the real keychain using a temporary credential.
- For a live smoke test after saving your key, run the first three generation examples with fresh output paths. Open the first image, confirm the fox PNG has a transparent background, and play the MP3 to confirm it is a 30-second clip. These calls use OpenRouter credits.
