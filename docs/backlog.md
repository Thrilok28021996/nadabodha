# Svara backlog

Audit of the PySide6 app after the sovereign rewrite. Ordered by risk × payoff.
Status reflects the build in `dist/Svara.app`.

## Fixed in the audit pass

- **Model preflight with progress.** Transcription checks the HF cache first; a
  missing model asks before downloading and shows a byte-based progress dialog
  instead of a silent 1.6 GB stall. Offline size lookup falls back to 1.6 GB.
- **Prompt presets restored.** `customPrompts` from the Electron settings are
  migrated to `prompt_presets`; Settings has a preset selector and “Save as
  preset…”, and the active text stays in `prompt_template`.
- **Transcript autosave and unsaved-changes guard.** Dictation autosaves the
  transcript, manual edits are tracked against the saved copy, and closing
  with changes asks Save / Discard / Cancel.
- **Audio decode no longer needs ffmpeg.** `decode_with_av` uses PyAV (bundled
  with faster-whisper); MP3/M4A/AIFF import works from the .app. ffmpeg is only
  a fallback.
- **Single instance.** `QLockFile` on the data dir.
- **Menu bar.** File → Settings (⌘,), Quit; Help → Open Log Folder.
- **Silent-microphone diagnosis.** RMS check explains Microphone permission /
  input-device problems instead of “no speech”.
- **Settings validation.** The dialog now rejects malformed model ids, missing
  cache folders, unusable output folders, invalid hotkeys, and identical
  recording/dictation hotkeys before saving.
- **Recording guardrails.** Input-device picker in Settings, optional maximum
  recording length (auto-stops and transcribes), and a 200 MB free-space check
  before capture starts.
- **Stale temp sweep.** Abandoned `svara-*` take directories older than a day
  are removed at startup and logged.
- **Watch folder.** The legacy `watchFolderDir` now maps to a real feature:
  audio dropped into the configured folder is picked up once its size is
  stable, queued while the app is busy, and transcribed/saved automatically.
  Existing files are snapshotted at startup so a restart does not replay them.
- **Library.** Header button / ⌘L opens a searchable table of every recording,
  transcript and summary in the output folder; open a transcript in the app,
  re-transcribe a recording, summarize a transcript, or reveal it in Finder.
- **Drag and drop + shortcuts.** Audio files can be dropped on the window
  (queued while busy); File menu now has Import (⌘O), Start/Stop Recording
  (⌘R), Save (⌘S), Copy Transcript (⇧⌘C), Summarize (⌘↩).
- **Timed exports.** Transcription keeps Whisper segment timings; File →
  Export SRT… / Export VTT… writes subtitles with proper timecodes.
- **Summary tooling.** Settings can test the local LLM server and populate the
  model field from its `/v1/models` list. The token budget is configurable and
  defaults to 4096; reasoning models that return an empty `content` with
  `finish_reason=length` are retried once with double the budget.
  Note: on this Mac `spark-x2.6-4b` reasons for ~25–65 s per summary.

- **System audio capture.** Settings → Record from can capture other apps
  through ScreenCaptureKit (`native/system_audio.swift`, helper in
  `assets/bin/`), alone or mixed with the microphone into one WAV. Needs Screen
  Recording permission. Verified: a `say` utterance from another process was
  captured and transcribed verbatim; mic+system mix transcribed too.
- **Permissions onboarding.** The window shows an Accessibility banner with
  an “Enable…” button whenever paste permission is missing, and polls every
  two seconds so it disappears as soon as the grant lands.

## P0 — correctness and trust

No open P0 items. The remaining work is P1/P2 below.

**TCC reality:** self-signed builds are rejected by Gatekeeper, so macOS ties
Accessibility/Microphone grants to the binary. Every rebuild requires granting
again; only a Developer ID + notarization changes that.

## P1 — workflow and polish

1. **Dictation options.** Press Return after paste, undo last dictation,
   choose keystroke-typing vs clipboard paste, language hint.
2. **Window and lifecycle.** Persist geometry/splitter, launch at login,
   menu-bar-only mode, About dialog with version.
3. **Theme follows the system** (Mocha/Latte automatic) in addition to the
   manual switch.
4. **Permissions onboarding.** At startup show Microphone/Accessibility state
   with buttons to open the right settings pane.
5. **Streaming summaries / cancel-retry** for long transcripts.

## P2 — engineering

17. UI tests (pytest-qt) for record→transcribe→save, dictation feedback and
    settings validation; hotkey dispatch needs an event-level test.
18. Cancellable transcription with progress from faster-whisper segments.
19. Optional GPU/MLX backend and configurable `compute_type`/`beam_size`.
20. Distribution: Developer ID signing + notarization, universal2, release
    automation (self-signed builds are local-only by design).
21. Store the LLM API key in the macOS Keychain instead of `settings.json`.
22. Localisation.
