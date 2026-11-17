# orgen — OpenRouter Image and Music CLI

Generate images and music from text prompts and save them in your project. You need Node.js 24+ and an [OpenRouter API key](https://openrouter.ai/settings/keys) with credits.

## Install and save your key

Run `npm link` from the `orgen` checkout. Then run `orgen auth set` in a Windows or WSL terminal. Paste your key at the hidden prompt and press Enter. It is saved in Windows Credential Manager for the current user under `orgen/openrouter`. Run `orgen auth set` again to replace it or `orgen auth clear` to remove it.

An exported `OPENROUTER_API_KEY` overrides the saved key for that process. You can also use the environment variable on other systems or when Windows interoperability is unavailable.

Run `orgen auth status` to see which credential source the CLI would use. This checks local configuration without contacting OpenRouter or displaying the key.

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
- With no output option, `orgen` creates a unique name in the current working directory. This also applies when `--prompt-file` points to another directory.
- The saved path goes to stdout. The generation cost reported by OpenRouter goes to stderr in USD, or appears as `Cost: unavailable` when the response has no cost.

Both commands accept `--prompt-file <path>` for a UTF-8 prompt file. Supply either a file or a quoted prompt. To get a machine-readable result, use `--json`.

```sh
orgen image --prompt-file prompts/fox.txt --background transparent -o assets/fox.png --json
orgen music --prompt-file prompts/loop.txt -o assets/loop.mp3 --json
```

JSON mode writes one object to stdout with the absolute `path`, the `model` reported by OpenRouter (or the requested model), and `costUsd` as a number or `null` if unavailable. Errors go to stderr.

Use `--reference` with a local PNG, JPEG, or WebP to guide a new image.

```sh
orgen image "Turn this fox into a winter illustration" --reference assets/fox.png
```

## Generate in bulk

List jobs in a JSON array. Each job has a `prompt` or `promptFile` and can specify an `output`. Relative paths are resolved from the directory running the command.

```json
[
  { "prompt": "Watercolor fox icon", "output": "assets/fox.png" },
  { "promptFile": "prompts/bear.txt" }
]
```

```sh
orgen image --batch jobs.json --background transparent --json
orgen music --batch tracks.json --full
```

Options such as `--background`, `--reference`, and `--full` apply to every job. The CLI validates the manifest and prompt files before making requests. It generates in order, keeps completed files, continues after job failures, and exits with status `1` if any job failed.

By default, stdout contains one saved path per successful job, and stderr shows costs, errors, and a summary. With `--json`, stdout contains an object with ordered `results` and `knownCostUsd`. Each result has a one-based `index` and a `costUsd`, plus either a `path` and `model` or an `error`. The subtotal includes reported costs, and unavailable job costs are represented as `null`.

## Use from Node.js

Link the package into your other Node.js project with `npm link orgen`. The client returns a `Buffer`, its MIME type, the model, and `costUsd`, which is `null` when OpenRouter omits the cost.

```js
import { createClient } from 'orgen';

const client = createClient({ apiKey: process.env.OPENROUTER_API_KEY });
const { bytes, mediaType, model, costUsd } = await client.generateImage({
  prompt: 'Watercolor fox icon',
  background: 'transparent',
});
```

To guide generation from an existing image, pass its bytes as `referenceImage` to `generateImage`.

## Verify locally

- Run `npm test` for offline tests. GitHub Actions runs the same suite on Linux and Windows with Node.js 24. From a regular WSL terminal, run `ORGEN_TEST_WINDOWS_KEYCHAIN=1 npm test` to also verify the real keychain using a temporary credential.
- For a live smoke test after saving your key, run the first three generation examples with fresh output paths. Check the reported cost, open the first image, confirm the fox PNG has a transparent background, and play the MP3 to confirm it is a 30-second clip. These calls use OpenRouter credits.
