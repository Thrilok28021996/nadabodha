# Dictation latency + fullscreen banner

Status: approved by user. Scope is dictation latency and the fullscreen banner.
Transcription/meeting speed is explicitly out of scope.

## Why

Dictation is the product. Measured on this machine (M4, 10 cores, macOS 27),
a 5-second utterance currently takes **~12 seconds** to land at the cursor.
The user's requirement: as fast as possible, **without losing accuracy**.

Measured breakdown for a 5s utterance with the current code:

| Cost | Measured | Source |
| --- | --- | --- |
| Language auto-detection (extra encoder pass) | ~4.2s | `transcriber.py:295` omits `language` |
| `without_timestamps` not set | ~2.0s | same call site |
| Cold model load, first dictation after launch | 1.8-3.4s | `_load_model()` is lazy |
| Model discarded on every Settings save | 1.8s | `main_window.py:387` |
| `beam_size=5` | ~0s | matmul-bound, not beam-bound |

Facts established while measuring, to prevent re-litigating them:

- `compute_type="int8"` is the only viable CPU option (float32 measured 60s,
  int8_float32 26s, int8 ~6s). CTranslate2 has no Metal on Apple Silicon.
- A smaller model would be ~15x faster (base: 0.41s vs turbo 6.12s) but the
  user rejected it: accuracy is non-negotiable.
- `condition_on_previous_text=False` loses content (48 chars -> 16). Rejected.

## Decisions taken by the user

1. English only. `language="en"` may be passed for dictation.
2. **Turbo everywhere.** No smaller model, for dictation or meetings.
3. Accuracy may not be traded for speed.
4. Banner must appear over a fullscreen app, both while transcribing and for
   the result.
5. Commit the pending `summarizer.py` and `build-dev-app.sh` + `native/launcher.c`.
   Delete the stale `assets/bin/svara-dev-launcher`.
6. Create `tests/test_dictation.py` (none exists today).
7. MLX/GPU path is in scope and to be measured, not skipped.

## The model in use (recorded for reference)

`deepdml/faster-whisper-large-v3-turbo-ct2`, 1.62 GB, ~809M params (matches
large-v3-turbo's 809M). Provenance is two hops from OpenAI:
`openai/whisper-large-v3-turbo` -> `deepdml/whisper-large-v3-turbo` (210
downloads) -> CT2 conversion. No official Systran turbo CT2 build exists.
MIT licence. Loaded as int8, so the app never runs the fp16 weights.

## Phase 1 - dictation latency (no new dependencies)

Expected: ~12s -> ~3.9s for a 5s utterance.

1. `transcriber.transcribe_result(path, *, language="", without_timestamps=False)`
   passes both through to `model.transcribe`.
2. Dictation calls with `language="en"` and `without_timestamps=True`.
   Meetings/imports/watch-folder keep timestamps (SRT/VTT) and keep
   auto-detect.
3. New setting `dictation_language`, default `en`, value `auto` allowed.
4. Preload the model in a background thread after startup so the first
   dictation does not pay the load.
5. `_apply_settings()` must keep the loaded model unless `model_repo` or
   `stt_cache_dir` actually changed.

## Phase 2 - MLX/GPU (measured, gated)

Same turbo weights at fp16 on Metal: more accurate than today's int8 *and*
faster. Acceptance is a benchmark, not a claim.

1. Add `mlx-whisper` to the sovereign env and the MLX turbo weights to
   `HF_HOME`, only with explicit go-ahead for the ~1.5 GB download.
2. `Transcriber` gets a backend selector: MLX when importable and available,
   else faster-whisper CPU. CPU stays the fallback, never removed.
3. Gate: MLX must beat CPU faster-whisper on the same real recording. If it
   does not, it is reverted and Phase 1 stands alone.
4. Quality check: transcribe the existing recordings on both backends and
   compare text before switching the default.

## Phase 3 - fullscreen banner

`StatusBanner.show_message()` calls `show()` first, then
`pin_window_to_every_space()`, then `raise_()`. Once macOS has ordered the
window into Svara's own Space, setting the collection behaviour afterwards
does not move it, and `raise_()` is not `orderFrontRegardless()`. The banner
therefore appears on normal desktops but not over a fullscreen app.

1. Pin collection behaviour and window level **before** `show()`.
2. Call `orderFrontRegardless()` after showing; re-assert level per show.
3. Apply the same treatment to `PasteToast`.
4. Human verification: dictate while a real app is fullscreen, confirm the
   banner shows for both "Transcribing..." and the result.

## Phase 4 - tests and housekeeping

1. `tests/test_dictation.py`: controller state machine (start/stop/cancel),
   guard blocks start, never hijack an in-flight recording, Carbon->pynput
   fallback reporting, and the new language/timestamp plumbing reaching
   `model.transcribe`.
2. Commit `svara/summarizer.py` (probe timeout 25s -> 60s; the summary model
   reasons for 25-65s, so a 25s probe reports a healthy server as broken).
3. Commit `scripts/build-dev-app.sh` + `native/launcher.c` (Mach-O launcher is
   what makes the mic TCC grant attribute to the app).
4. Delete `assets/bin/svara-dev-launcher` (stale; the build compiles the
   launcher now).

## Out of scope

Meeting/file transcription speed, summary speed, smaller models, the stale
`svara-v3-end-to-end.md`, live streaming, CI, linter config, LICENSE.

## Acceptance criteria

- Dictation of a 5s utterance: before/after timing captured on real audio.
- Transcription output for dictation is byte-identical to today's for the
  same clip (timestamp/language flags must not change the text).
- Meeting transcription still produces segments and SRT/VTT export still works.
- Banner visible over a fullscreen app (human-verified).
- `python3 -m pytest tests -q` green, including the new `test_dictation.py`.
- `python3 -m svara --self-test` green.

## Risks

- `language="en"` on a non-English speaker degrades output; mitigated by the
  `dictation_language` setting with `auto` available.
- `without_timestamps=True` must never reach the meeting path or SRT/VTT
  export loses timecodes; proved by a test asserting the flag is not set for
  non-dictation origins.
- MLX may not beat CPU on this machine; the phase is gated and revertible.
- Preloading raises idle memory by ~1.6 GB on a machine already at 7.27 GB
  swap. Preload must be optional (`preload_model` setting) and off by default
  if it causes pressure.
