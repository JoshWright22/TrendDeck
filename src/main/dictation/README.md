# Dictation

One active source turns speech into text, picked in Settings, Dictation and switched from the composer's mic menu. The source is `local:<model id>` or `provider:<config id>`.

- **Local models (default).** A model from the catalog runs on this computer in a Web Worker (`src/renderer/src/dictation/whisper.worker.ts`) with transformers.js and the onnx runtime: WebGPU when the GPU gives an adapter and the session starts, otherwise WebAssembly on the CPU. Audio never leaves the computer.
- **Local servers.** A transcription server you run on this computer (whisper.cpp, Speaches, LocalAI, any OpenAI-compatible one). Loopback addresses only.
- **Cloud APIs.** One adapter per provider in `providers/`. Main uploads the audio with the key; keys never reach the page or the agent.

## Pieces

- `src/shared/dictation.ts`: options, IPC channels, the local model catalog (`LOCAL_MODELS`), languages, and the metadata types the page sees about providers.
- `index.ts`: `setupDictation(window, trustedRendererUrl)`, called once per main window from `src/main/index.ts`. Every channel checks the sender is that window's main frame on the trusted URL. Stores the config (`userData/dictation/config.json`, version 2) with secret provider fields as `safeStorage` ciphertext, and registers every saved key with the gateway so tool results and the audit log never show one.
- `models.ts`: downloads a model variant once from `https://huggingface.co/<repo>/resolve/main/<file>` into `userData/stt/models/<id>/<dtype>/`. Each file is checked against the size and sha256 (or git blob sha1) from the Hugging Face tree API, written as `.part` then renamed; `manifest.json` is written last. Several downloads can run at once, with progress events (`dictation:model-progress`), cancel and delete. Custom models: any `onnx-community/<name>` Whisper or Moonshine repo, stored in `userData/stt/custom.json`.
- `src/main/media/protocol.ts` serves `td-media://stt/<id>/<dtype>/<file>` through `servedModelFile`: only the files that variant lists, of a finished download.
- `sources.ts`: the provider registry as main uses it, and the migration of the old single-API config.
- `providers/`: the adapters. `http.ts` holds the shared network rules (checked URLs, no redirects, 120 s timeout tied to cancel, 1 MiB response cap, error messages with no body, URL or key), `timing.ts` turns provider answers into words with times.
- `tools.ts`: gateway tools for the agent. `dictation_status` (read: the GPU in use, WebGPU and hardware acceleration, local models with download state and size, providers as configured yes or no, the recommended model) and `dictation_setup` (edit: downloads a local model in main and makes it the source, waits 45 s then says it's still going). Local models only, never a provider. A change made there reaches the window as `dictation:config-changed`.
- `pick.ts`: the GPU facts from `app.getGPUInfo('basic')` and `app.getGPUFeatureStatus()`, and the pick rule: a dedicated GPU with WebGPU gets Whisper Large v3 Turbo, built-in graphics Whisper Small, no WebGPU or acceleration Whisper Base.
- `preload.ts`: `dictationBridge(ipcRenderer)`, exposed as `window.trenddeckDictation`.
- `src/renderer/src/dictation/engine.ts`: what the rest of the ui calls. `transcribePcm`, `decodeToPcm`, `dictationReady`, `warmUp`, `encodeWav`, the source switcher.

## Local models

Only the active model is loaded; switching unloads the old one, and the worker drops it after five idle minutes. Each model can have several downloads (fp32, fp16, q8, q4); the precision and device (auto, WebGPU, CPU) are per model.

| family | ids | word times |
|---|---|---|
| Whisper (`_timestamped` exports) | tiny, base (default), small, medium, each also `.en`; large-v3-turbo | exact |
| Distil-Whisper | distil-small.en, distil-large-v3.5 | spread over segments |
| Moonshine | moonshine-tiny, moonshine-base (English only) | spread over segments |

## Providers

| kind | adapters |
|---|---|
| Cloud APIs | OpenAI, Groq, Deepgram, AssemblyAI, ElevenLabs Scribe, Google Cloud Speech-to-Text v2, Azure AI Speech, Speechmatics, Rev.ai, Gladia, Mistral (Voxtral), Fireworks, Together, OpenRouter, any OpenAI-compatible endpoint |
| Listed, not usable yet | AWS Transcribe (needs an S3 bucket and SigV4 signing) |
| This computer | whisper.cpp server, Speaches (faster-whisper-server), LocalAI, any OpenAI-compatible local server |

Hosted endpoints must be HTTPS; local servers must be on 127.x, `localhost` (pinned to 127.0.0.1) or `[::1]`. A provider's Test button makes a cheap authenticated GET and never uploads audio. Where a provider gives word times they are used; otherwise words are spread over the provider's segments, or over the whole text, and the result is marked approximate. A changed server address drops the saved key.

Old configs still load: the first local-model version (`localModel`) becomes `local:<id>`, and the single API config (`{ mode, baseUrl, model }` plus `encryptedKey`) becomes a configured provider called `migrated` (OpenAI, a local OpenAI-compatible server, or a generic endpoint) with its key.

## Runtime files

`electron.vite.config.ts` copies `ort-wasm-simd-threaded.asyncify.mjs` and `.wasm` from onnxruntime-web into the renderer output as `ort/` (served by middleware in dev) and aliases `onnxruntime-web/webgpu` to the build that loads them from there. The worker sets `wasmPaths` to that folder, `allowRemoteModels = false`, `useBrowserCache = false`. The built app's CSP adds `'wasm-unsafe-eval'` to `script-src` and `connect-src 'self' td-media: blob:`. Nothing loads from a CDN.

## Tests

`TRENDDECK_SKIP_FFMPEG=1 npx vitest run src/main/dictation` and `npm run typecheck`. Adapters are tested against the request and answer shapes in each provider's API reference, with empty keys. With `TRENDDECK_TEST_HOOKS=1` the window gets `window.__tdWhisper` (the engine functions) so a CDP driver can transcribe a file; it is off otherwise.
