# Nadabodha

Local-only audio transcription desktop app for macOS. Built with Electron (TypeScript) and a Python adapter that runs speech-to-text on your Mac without uploading audio to any service.

## Features

- Record microphone audio to WAV using ffmpeg.
- Import existing audio files: WAV, MP3, M4A, OGG, FLAC, AAC, AIFF, WMA.
- Transcribe locally using one of these adapters, tried in order:
  1. whisper.cpp (`whisper-cli` on PATH)
  2. OpenAI Whisper (`openai-whisper` Python package)
  3. Vosk (`vosk` Python package + `VOSK_MODEL` directory)
  4. Mock fallback for scaffold testing (no model required)
- Progress, cancel, and error handling via IPC.
- Copy transcript to clipboard and save as plain `.txt`.

## Project structure

```
.
├── package.json              # Electron + TypeScript build scripts
├── tsconfig.json             # TypeScript config (rootDir: src, outDir: dist)
├── jest.config.js            # Jest + ts-jest settings
├── src/
│   ├── main/                 # Electron main process
│   │   ├── main.ts           # Window bootstrap
│   │   ├── ipcHandlers.ts    # IPC handlers
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
  - whisper.cpp `whisper-cli` binary on PATH + `WHISPER_MODEL`
  - `vosk` + `VOSK_MODEL` directory

## Install

```bash
npm install
python3 -m pip install -r python/requirements.txt
```

For real transcription, uncomment and install the desired backend in `python/requirements.txt`, then install again:

```bash
python3 -m pip install openai-whisper
```

## Run

```bash
npm run start
```

This compiles TypeScript, copies renderer assets, and launches Electron. The main entry point is `dist/main/main.js`, the preload bundle is `dist/preload/preload.js`, and the renderer loads from `dist/renderer/index.html`.

## Tests

```bash
npm test
npm run test:python
```

## Scripts

- `npm run build` — compile TypeScript to `dist/`
- `npm run watch` — compile TypeScript in watch mode
- `npm run start` — build and run Electron
- `npm test` — run TypeScript unit tests
- `npm run test:python` — run Python adapter tests
- `npm run lint` — lint the TypeScript sources with ESLint

## Limitations

- v1 is a local-only scaffold. No cloud transcription, accounts, or sync.
- Recording depends on ffmpeg with the avfoundation input device on macOS.
- No live waveform visualization or text editor in v1.
