# Svara

Svara is a sovereign, local-only macOS desktop app for dictation, audio
transcription and transcript summaries. It is built entirely with **Python and
PySide6** — there is no Electron, no Node.js and no bundled browser runtime.

## Features

- **Record** from the microphone (ffmpeg) or **import** an audio file.
- **Transcribe** locally with Whisper [large-v3 turbo](https://huggingface.co/deepdml/faster-whisper-large-v3-turbo-ct2)
  through `faster-whisper`.
- **Dictate** system-wide with Option+Space: press once to start, again to
  finish. The text is appended to the transcript and pasted at the cursor.
- **Summarize** through a local OpenAI-compatible server such as LM Studio.
- **Copy** or **save** the transcript as plain text.
- Every completed recording is kept in the app's `recordings/` folder before
  transcription, so a pipeline failure can never lose the audio.
- Runtime failures are written to a JSON-lines log for later diagnosis.
- Catppuccin Mocha (default) and Latte themes, selectable in Settings.
- Dictation feedback: a short chime when the transcript is ready, a
  Notification Center banner when the text is only on the clipboard, and a
  “ready to paste” card next to the cursor.
- Optional watch folder: audio files dropped there are imported and
  transcribed automatically.
- **System audio capture**: record other apps (meetings, calls, videos) through
  ScreenCaptureKit, either on its own or mixed with the microphone, so both
  sides of a call land in one transcript. Needs Screen Recording permission.
- Library window (⌘L) to browse past recordings, transcripts and summaries.
- Drag an audio file onto the window to transcribe it, plus menu shortcuts:
  Import (⌘O), Record (⌘R), Save (⌘S), Copy transcript (⇧⌘C), Summarize (⌘↩).
- Subtitle export (SRT/VTT) with Whisper segment timings, and summary-server
  “Test connection” / “List models…” helpers in Settings.

## Requirements

- macOS
- Python 3.10+ (developed and tested against Python 3.13)
- `ffmpeg` on `PATH`
- Python dependencies from `requirements.txt`
- A local OpenAI-compatible LLM server for summaries (optional)
- Accessibility permission for automatic cursor paste (the global dictation
  hotkey itself uses Carbon and needs no permission). Without it the Dictate
  button still records and transcribes; text is left on the clipboard.

## Install and run

```bash
python3 -m pip install -r requirements.txt
python3 -m svara
```

Or use the launcher, which prefers the personal sovereign interpreter:

```bash
./scripts/run-svara.sh
```

`SVARA_PYTHON` overrides the interpreter. `python3 -m svara --data-dir DIR`
uses a different user-data directory.

## Where data lives

Generated files go to the configured output folder — `/Volumes/personal/meetings`
by default:

```
recordings/     completed WAV takes (kept)
transcripts/    transcript-<timestamp>.txt (auto-saved after transcription)
summaries/      summary-<timestamp>.md (auto-saved when a summary is produced)
```

Change it in **Settings → Output folder**; app internals stay under
`~/Library/Application Support/Svara/`:

```
settings.json      persisted preferences
logs/svara.log     JSON-lines runtime log (rotates at 2 MB)
```

`SVARA_DATA_DIR` overrides the app-internal directory; that is how the
headless self-test avoids touching real data.

## Dictation

Option+Space toggles a dictation take from anywhere. Press ⌘⇧R to start and stop
a full recording from anywhere (the same take the Record button produces).

Both hotkeys are Carbon `RegisterEventHotKey` registrations, so they need no
Accessibility permission; the automatic Cmd+V paste does, and the app tells you
in the hint line when that is missing. When a paste still cannot happen
(permission revoked, secure input, or a failed keystroke), a small card appears
next to the cursor saying the dictation is ready and that the text is on the
clipboard. macOS Secure Input (password fields) is detected before pasting, so
dictated text is never typed into one. When Svara itself has focus, the text is
only appended in-app.

A small always-on-top banner appears when a dictation take stops — first
“Transcribing…”, then “Pasted” or “Copied — press ⌘V”. It never takes keyboard
focus, so you can see that the stop registered without switching apps.

### Recording other apps

Settings → **Record from** chooses what a manual recording captures:

- **Microphone** — the default, one input device.
- **System audio** — everything other apps play (Zoom, Teams, browser, VLC),
  captured with ScreenCaptureKit; Svara's own sounds are excluded.
- **Microphone + system audio** — both streams, summed into one 16 kHz mono WAV,
  so a call has both sides in a single transcript.

System audio needs macOS Screen Recording permission for Svara; the first
attempt prompts, and Settings → Privacy & Security → Screen Recording controls
it afterwards. If nothing is playing, the helper refuses rather than saving a
silent file. The helper lives in `native/system_audio.swift` and is compiled
into `assets/bin/svara-system-audio`. Dictation always uses the microphone.

## Settings

The Settings dialog configures the speech model and cache directory, the local
LLM URL/model/API key, the summarization prompt, and dictation behaviour. The
default speech model is Whisper large-v3 turbo
(`deepdml/faster-whisper-large-v3-turbo-ct2`, 1.6 GB). It downloads on first
use into the configured Hugging Face cache; existing installs that still had
the old `Systran/faster-whisper-base` default are migrated automatically.

## Verification

```bash
python3 -m pytest tests -q          # unit tests
python3 -m svara --self-test        # headless app/build checks
```

The self-test verifies logging, settings round-trips, the summarizer request
shape, ffmpeg/helper presence, the transcriber import, and that the Qt window
constructs and closes under the offscreen platform.

## Build

```bash
./scripts/build-dev-app.sh   # dev bundle: runs this repo with the sovereign python
open "dist/Svara Dev.app"
```

The dev bundle contains only a signed launcher, so editing Python code does not
change its binary — grant Accessibility/Microphone once to **Svara Dev** and
ordinary edits keep the grant. Use it while iterating.

For the self-contained app:

```bash
./scripts/build-app.sh
open dist/Svara.app
```

Self-signed builds are accepted locally but Gatekeeper still rejects them, so
macOS keys their TCC (Accessibility/Microphone) grants to the binary, not to the
certificate: **each rebuild of `dist/Svara.app` requires granting Accessibility
again**. Only an Apple Developer ID signature with notarization gives durable
grants and distribution outside this machine (not pursued here). The app shows
a banner with an “Enable…” button whenever paste permission is missing.

## Privacy and sovereignty

Data sovereignty is real: audio, recordings, transcripts and summaries stay in
`/Volumes/personal/meetings` and `~/Library/Application Support/Svara/`; there is
no telemetry, analytics, account or cloud service. The code contains no outbound
URLs other than the summary server you configure (default `127.0.0.1`).

Runtime sovereignty is narrower, and worth stating plainly:

| Piece | Bundled? | Needs network? | Notes |
| --- | --- | --- | --- |
| Speech-to-text | no | first run only | Whisper weights come from the Hugging Face cache; once cached, `HF_HUB_OFFLINE=1` transcription works (verified). |
| Summaries | no | no | Requires a local OpenAI-compatible server (LM Studio, llama.cpp). Without it, summaries are unavailable; nothing leaves the machine. |
| Recording, dictation, paste, exports, library, watch folder | yes | no | Pure local code and macOS APIs. |
| Packaging | yes | no | `dist/Svara.app` is self-contained apart from the model cache and summary server. The dev bundle intentionally depends on this repo and the conda env. |

To make the app fully self-contained you would bundle the Whisper weights
(~1.6 GB) and an embedded llama.cpp + GGUF model for summaries, taking the app
to several GB. That trade-off has not been made; the current definition is
“local-data sovereign, with a cached speech model and an optional local LLM”.
