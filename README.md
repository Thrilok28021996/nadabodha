# Nadabodha

Local-only audio transcription desktop app for macOS. Built with Electron (TypeScript) and a Python adapter that runs speech-to-text on your Mac without uploading audio to any service.

## Features

- Record microphone audio to WAV using ffmpeg.
- Import existing audio files: WAV, MP3, M4A, OGG, FLAC, AAC, AIFF, WMA.
- Transcribe locally, tried in order:
  1. The Hugging Face model selected in Settings (faster-whisper/CTranslate2 or PyTorch via transformers)
  2. OpenAI Whisper (`openai-whisper` Python package)
  3. whisper.cpp (`whisper-cli` on PATH)
  4. Vosk (`vosk` Python package + `VOSK_MODEL` directory)
  5. Mock fallback for scaffold testing (no model required)
- Settings panel (gear icon): Python interpreter, local LLM, data directory,
  model cache directory, summarization toggles.
- Hugging Face model browser with search, format classification, one-click
  download with live progress, installed/active model management.
- Optional LLM summarization (LM Studio or any OpenAI-compatible server),
  automatic after transcription or manual from the Summary tab.
- Auto-save of transcripts (`.txt`) and summaries (`.md`) into the data
  directory, with the saved paths shown in the UI.
- Progress, cancel, and error handling via IPC.
- Copy transcript to clipboard and save as plain `.txt`.

## Project structure

```
.
├── package.json              # Electron + TypeScript build scripts
├── tsconfig.json             # TypeScript config (rootDir: src, outDir: dist)
├── jest.config.js            # Jest + ts-jest settings
├── scripts/
│   ├── copy-assets.js        # copies renderer assets to dist/
│   └── cdp-smoke.mjs         # end-to-end CDP smoke test (optional, dev only)
├── src/
│   ├── main/                 # Electron main process
│   │   ├── main.ts           # Window bootstrap
│   │   ├── ipcHandlers.ts    # IPC handlers (settings, LLM, HF, summary)
│   │   ├── settingsStore.ts  # settings.json load/save/merge + python probe
│   │   ├── autoSave.ts       # data-dir layout, timestamped .txt/.md writes
│   │   ├── summarizer.ts     # OpenAI-compatible chat/completions client
│   │   ├── hfModels.ts       # HF search, repo classification, installed scan
│   │   ├── modelDownloadService.ts
│   │   ├── transcriptionService.ts
│   │   ├── transcriptionAdapter.ts
│   │   ├── audioRecorder.ts
│   │   └── exportText.ts
│   ├── preload/              # Secure context bridge
│   │   └── preload.ts
│   ├── renderer/             # UI
│   │   ├── index.html
│   │   ├── renderer.ts
│   │   └── styles.css
│   └── shared/               # IPC contracts and format helpers
│       ├── ipc.ts
│       └── audioFormats.ts
└── python/
    ├── nadabodha_transcribe.py
    ├── requirements.txt
    └── tests/test_transcribe.py
```

## Requirements

- macOS
- Node.js 18+ and npm
- Python 3.9+ with `pytest` for Python tests
- ffmpeg (for recording and import normalization)
- (Optional) one local transcription backend:
  - `openai-whisper` — install with `pip install openai-whisper`
  - `faster-whisper` + a downloaded CTranslate2 model (installed from Settings)
  - `transformers` + a downloaded PyTorch ASR model (installed from Settings)
  - whisper.cpp `whisper-cli` binary on PATH + `WHISPER_MODEL`
  - `vosk` + `VOSK_MODEL` directory
- (Optional) a local OpenAI-compatible LLM server for summarization, e.g. LM Studio

## Install

```bash
npm install
python3 -m pip install -r python/requirements.txt
```

For real transcription, uncomment and install the desired backend in `python/requirements.txt`, then install again:

```bash
python3 -m pip install openai-whisper
```

> On hosts where npm skips Electron's postinstall, run
> `node node_modules/electron/install.js` once after `npm install` (and make
> sure `node_modules/electron/path.txt` contains
> `Electron.app/Contents/MacOS/Electron`), otherwise Electron will not launch.

## Run

```bash
npm run start
```

This compiles TypeScript, copies renderer assets, and launches Electron. The main entry point is `dist/main/main.js`, the preload bundle is `dist/preload/preload.js`, and the renderer loads from `dist/renderer/index.html`.

## Settings

Click the gear icon in the header to open the panel. **Save settings** validates each field and persists everything to
`<userData>/settings.json` (for a dev run: `~/Library/Application Support/Nadabodha/settings.json`). Invalid fields are
reported inline and simply not persisted; valid fields still save.

| Field | What it does |
| --- | --- |
| **Python interpreter** | Interpreter used to run `python/nadabodha_transcribe.py`. Text field + **Browse…** (open dialog) + **Validate**. On save the path is checked for existence/executability and probed with `<path> -c "import whisper"`; the inline line shows `OK` or the specific error (e.g. `ModuleNotFoundError`). A missing/non-executable path blocks saving that field; a failed import probe is shown but still savable so dependencies can be installed later. |
| **Local LLM base URL** | OpenAI-compatible server, default `http://127.0.0.1:1234/v1` (LM Studio). |
| **Model** | Dropdown populated live from `GET <base>/models` — typing a new base URL or clicking **Load models** refreshes it. |
| **API key** | Optional; sent as `Authorization: Bearer …` when set. LM Studio does not need it. |
| **Test Connection** | Shows `Connected — N model(s) available` or the concrete HTTP/network error inline. |
| **Data directory** | One folder (text field or **Choose…** open panel). On save the app creates `transcripts/`, `summaries/`, `scripts/` and writes `scripts/summarize-prompt.md` (the editable summarization prompt). An unwritable folder is rejected with a clear inline error. |
| **STT model cache directory** | Where Hugging Face models are downloaded. Defaults to `$HF_HOME` or `~/.cache/huggingface`. Files always land directly in this folder (`models--org--name/…`), never in `~/.cache`, because it is passed as the cache directory to `huggingface_hub`, `faster-whisper` and `transformers`. |
| **Enable summarization** | Master switch for LLM summarization. |
| **Summarize automatically…** | Runs a summary when a transcription completes (only if an LLM base URL *and* model are configured). |

### Python interpreter precedence

When launching the adapter the interpreter is resolved in this order:

1. the saved **Python interpreter** setting (if non-empty),
2. the `NADABODHA_PYTHON` environment variable,
3. `python3` from `PATH`.

### Hugging Face model browser

- The search box queries `https://huggingface.co/api/models?pipeline_tag=automatic-speech-recognition&search=<q>&sort=downloads&direction=-1`
  (debounced 400 ms). An empty query lists the top ASR models by downloads.
- Each row shows the model id, download count and the format the app would use:
  **CTranslate2** (faster-whisper), **PyTorch** (transformers pipeline), or an
  unsupported label with a reason.
- Repos that cannot run locally as speech-to-text are rendered non-selectable
  with the reason inline: ggml/whisper.cpp weights (`ggerganov/whisper.cpp`),
  CoreML/WhisperKit (`argmaxinc/whisperkit-*`), `pyannote/*` diarization and
  MLX weights. Requesting such a model over IPC is refused with an error event.
- **Download selected** streams progress events (percent + bytes) into the
  panel, is cancellable, and resumable — partial files stay in the cache and
  the next download continues. On completion the model appears under
  **Installed**.
- **Set active** marks the installed model as the one used first by the
  fallback chain. **Installed** always reflects the configured cache directory.

### Summarization with LM Studio

1. Start LM Studio's local server (OpenAI-compatible, default `http://127.0.0.1:1234/v1`).
2. Open Settings → set **base URL**, click **Load models**, pick a model, click **Test Connection**, then **Save settings**.
3. Enable **Enable summarization** (and optionally *Summarize automatically*).
4. Transcribe — the summary appears in the **Summary** tab next to the transcript, or press **Summarize** for a manual run.
5. Edit the prompt template at `<data dir>/scripts/summarize-prompt.md` (`{{transcript}}` is replaced with the transcript; changes apply to the next run). Without a data directory the built-in template is used.

Failures never break the transcript: an unreachable server or a non-2xx reply shows an inline error in the Summary tab while the transcript stays copyable and saveable, and the run can be cancelled.

### Auto-save

- On a completed transcription the transcript is written to
  `<data dir>/transcripts/transcript_YYYY-MM-DD_HH-mm-ss.txt`.
- A completed summary is written to `<data dir>/summaries/summary_YYYY-MM-DD_HH-mm-ss.md`.
- Both paths are shown under **Saved files** in the UI. Same-second files get a `-1`, `-2`, … suffix instead of overwriting.
- If the directory is unwritable the UI shows `Cannot write …` and the app keeps running.
- With no data directory configured, nothing is auto-saved (manual **Save as Text** still works).

### Which loader runs a model

| Repo | Loader |
| --- | --- |
| tagged `ctranslate2` / `ct2` / id contains `faster-whisper` (e.g. `Systran/faster-whisper-base`) | `faster_whisper.WhisperModel(repo, download_root=<cache dir>)` |
| PyTorch ASR (`openai/whisper-*` and friends) | `transformers` Whisper pipeline with `cache_dir=<cache dir>` |
| ggml/whisper.cpp, CoreML/WhisperKit, `pyannote/*`, MLX | refused — surfaced in the UI as non-selectable with a reason, and an error event if forced |

Snapshots are fetched with `huggingface_hub.snapshot_download` (progress callbacks, cancellable, resumable) into the configured cache directory before the loader runs.

## Network

The app is local-only. The only outbound destinations are:

- `http://127.0.0.1:1234/v1` (or whatever base URL you configure) for LLM
  summarization and the model-list/Test-Connection call.
- `huggingface.co` (plus its CDN/mirror domains `*.huggingface.co` and
  `*.hf.co`) for model search metadata and model downloads only.

Audio, transcripts and summaries are never sent anywhere. The renderer cannot
make network requests at all (CSP `default-src 'self'`); every fetch happens in
the main process and model downloads are restricted to Hugging Face hosts.

## Tests

```bash
npm test
npm run test:python
```

- `npm test` covers settings load/save/merge/corrupt-file recovery, Python
  interpreter precedence and validation, Hugging Face repo classification,
  summarizer request construction plus error/cancel handling, and auto-save
  filename/path logic.
- `npm run test:python` covers the adapter server protocol and the Python-side
  repo classification (ctranslate2 vs pytorch vs unsupported).
- `node scripts/cdp-smoke.mjs` launches the app with
  `--remote-debugging-port=9222` and drives the real UI over CDP (optional;
  requires a live LM Studio server for the summarization step).

## Scripts

- `npm run build` — compile TypeScript to `dist/`
- `npm run watch` — compile TypeScript in watch mode
- `npm run start` — build and run Electron
- `npm test` — run TypeScript unit tests
- `npm run test:python` — run Python adapter tests
- `npm run lint` — lint the TypeScript sources with ESLint

## Troubleshooting

- **Recording fails with "Microphone access denied"** — macOS only lets an app
  capture audio after you grant it: open **System Settings > Privacy &
  Security > Microphone** and enable the app (Nadabodha for packaged builds,
  Electron when running from a dev build with `npm run start`), then start the
  recording again. macOS may require restarting the app for the new permission
  to take effect.
- **"Probe failed: ModuleNotFoundError: No module named 'whisper'"** — the
  selected interpreter cannot import `openai-whisper`. Either install it for
  that interpreter or pick another one; the app still runs (the fallback chain
  continues), it just will not use that backend.
- **Model download errors** — downloads only contact `huggingface.co`. If the
  cache directory is on an unmounted volume the save step reports it inline.

## Limitations

- v1 is a local-only app. No cloud transcription, accounts, or sync.
- Recording depends on ffmpeg with the avfoundation input device on macOS.
- No live waveform visualization, text editor, TTS, translation or diarization in v1.
- Summarization requires a local OpenAI-compatible server (no Ollama-specific integration).
