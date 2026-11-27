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

## Results (measured)

Baseline captured before any change with `scripts/bench_dictation.py`; same
machine, same audio, same run. The table was written at `3d4319d` and last
edited at `a314c1a`, both before the second-review fixes landed in `72d31fd`.
The recording used was never written down -- the bench picks the newest `.wav`
by mtime -- so the rows below are a point-in-time record, not numbers
reproducible from today's tree (see the re-run note under the gates).

| Case | Before | After | |
| --- | --- | --- | --- |
| Dictation, 5s real clip (cold) | 14.49s | 5.33s | Phases 1 |
| Dictation, 5s real clip (warm) | 12.75s | 5.38s | Phase 1 |
| Dictation, 6.4s clean clip, CPU | 5.90s | 5.90s | unchanged |
| Dictation, 6.4s clean clip, GPU | n/a | **1.12s** | Phase 2, 5.0x vs CPU |
| Dictation, 6.4s clean clip | 5.63s | **1.31s** | Phase 2, end to end |
| Meeting, 74.5s | 12.06s | 12.06s | unchanged by design (CPU, beam-5 + VAD) |

The clean-speech clip is the honest dictation number: the 5s real clip is faint
and repeatedly fails Whisper's logprob threshold, which triggers temperature
fallback re-decodes in both backends and inflates every figure.

Gates: `pytest tests -q` 148 passed (119 before), `--self-test` 6/6, SRT export
verified to still carry real timecodes through the MLX path. Re-verified at
`72d31fd` on 2026-11-26 with the sovereign interpreter
(`/Volumes/personal/conda_envs/sovereign/bin/python3`, `PYTHONPATH` unset):
148 passed, self-test 6/6. The 119 baseline was re-checked the same day on
`main` (79b1137) and holds.

Correction (2026-11-27): these gates did **not** verify the preload path, and
they must not be read as if they had. The bench script and the unit tests both
preload and transcribe on one thread, so they stayed green while every real
dictation with the default `preload_model: true` was failing on the MLX
backend. Green above means the paths those commands exercise, nothing more;
the preload-then-transcribe defect and its fix are recorded in the section
below.

### Re-run at 72d31fd (2026-11-26): the 5s-clip rows do not reproduce

All three bench commands re-run at `72d31fd` on the newest recording,
`recording-2026-11-26T15-53-13-555026.wav` (peak 2149/32767 -- the faint clip
the caveat above warns about); transcripts checked with `--text`:

| Command | Cold | Warm | Transcript |
| --- | --- | --- | --- |
| CPU, auto language, timestamps on | 8.80s | 10.97s median | `''` |
| CPU, `language=en`, no timestamps | 0.03s | 0.01s median | `''` |
| MLX, auto language, timestamps on | 7.59s | 7.28s median | `'Hello?'` |

The 5.33s/5.38s figures for the 5s real clip did not reproduce, and the fresh
CPU figures are not latency measurements at all: the CPU path hardcodes
`vad_filter=True` (present since 79b1137, unchanged by both fix commits) and VAD
rejects this clip as non-speech before any decode happens. Isolation probe
against the shipped code, same model and knobs: `language=en` with VAD on ->
0.03s, `text ''`; VAD off -> 12.04s, `text 'For more information, visit
www.fema.org'`. The MLX path passes no VAD, so its row is the only run above
that actually decoded.

Two reasons the published rows cannot be regenerated from this tree: the clip
filename was never recorded while the bench auto-picks the newest `.wav` by
mtime, and the faint-clip CPU figures depend on a VAD rejection this plan never
measured. The clean-clip rows (the honest dictation number) and the meeting row
were **not re-verified at `72d31fd`** -- the commands above only cover the
newest recording. Treat the table above as the original measurement, not as a
current one; the fresh figures are not a replacement for it.

### Phase 2 outcome: kept, for dictation only

MLX is 5x faster on dictation-length audio, so it is now the dictation backend.
It is deliberately NOT used for recordings or imports: `mlx_whisper` implements
neither beam search (`decoding.py` raises `NotImplementedError` for
`beam_size`) nor VAD, so routing meetings through it would replace the verified
beam-5 + VAD decode with a greedy one. That is an accuracy change to a path
declared out of scope, so the meeting path stays on CTranslate2 exactly as it
was. `transcribe_options()` returns `allow_gpu: False` for every non-dictation
origin, and a test pins it.

Accuracy check on real dictation clips (CPU beam-5 int8 vs GPU greedy fp16):
identical on 1 of 5 clips, with small differences elsewhere -- one clip where the
CPU heard "Feels so slow" and the GPU heard "feels a slope". The GPU is faster,
not more accurate; the README says so, and `stt_backend=cpu` restores the
previous output exactly. This is the one place where the plan's "no accuracy
trade" rule and the user's explicit choice of MLX pull against each other, so it
is called out rather than buried.

MLX also bypassed the configured model cache: `mlx_whisper` resolves a repo id
with a bare `snapshot_download()`, which would have pulled a second 1.5 GB copy
into the default HF home. The backend now resolves the snapshot inside
`stt_cache_dir` itself and passes a local path.

### Preload + dictation on separate threads: broken, then fixed (2026-11-27)

With the default `preload_model: true` on the MLX backend, every dictation
failed:

```
Transcription failed: There is no Stream(gpu, 1) in current thread.
```

`_PreloadWorker` materialised the model on one QThread; every
`_TranscribeWorker` ran on a different thread. `mlx_whisper` caches the model
in a process-global `ModelHolder` and the model's compute state belongs to the
thread that first materialised it, so `mx.async_eval` raised on every other
thread. Measured on base `be5ba111` before the fix: preload on thread A,
transcribe on threads B and C -> both fail; `mx.eval` of the model parameters
in the preload thread does **not** help; setting a fresh default stream on the
transcribing thread does **not** help either (`new_thread_local_stream` is
rejected by `set_default_stream`). What works, measured: confine the model
load and every transcription to one process-wide thread.

Fix (this plan's diff): one module-level `ThreadPoolExecutor(max_workers=1)`
in `svara/transcriber.py` runs both the GPU plan's model load and the whole
`_transcribe_mlx` call body, so exactly one thread ever touches the model; the
CPU path never starts it. Unit tests `test_preload_and_mlx_transcription_share_one_thread`
and `test_cpu_backend_starts_no_mlx_worker` pin the invariant, and the new
`scripts/probe_mlx_preload_threads.py` drives the production thread shape
headlessly -- the bench script cannot see the defect because it preloads and
transcribes on one thread.

Measured at the candidate with
`scripts/probe_mlx_preload_threads.py --shape preload-then-transcribe-twice`
(newest recording, 5s clip, `backend=auto` -> MLX):

| Phase | Measured |
| --- | --- |
| preload, thread A | 0.40s |
| first dictation, fresh thread B | 2.16s |
| second dictation, fresh thread C | 2.02s |
| no-preload single call (cold, one thread) | 5.28s |

Both transcriptions returned identical text (`Hello can you hear me? Hello my
question is 123 Hello can you hear me?`). Which thread ran them was not
measured correctly at that point: the probe printed the fresh *caller* thread
it spawned, not the thread MLX ran on (fixed with B1, measured below). The
no-preload line is measured in a subprocess, because
`ModelHolder` is process-global and an in-process run would time only the
decode. Gates at that commit: `pytest tests -q` 150 passed (148 + 2 new),
`--self-test` 6/6, both probe shapes exit 0; the probe exits non-zero with the
production error string on the base commit.

Defence in depth (added with this card): if the thread-affinity error ever
escapes again -- some other lazily built buffer outside the one-thread rule --
`transcribe_result` logs it in full (message plus traceback, scope
`transcription`) and finishes the take on the CPU backend instead of failing
it, so a take degrades rather than hard-fails. Only MLX's
`There is no Stream(gpu, N) in current thread` degrades; every other GPU error
still propagates unchanged. Pinned by
`test_stream_affinity_failure_is_logged_and_finished_on_the_cpu`,
`test_unrelated_gpu_errors_still_propagate` and
`test_stream_affinity_error_is_detected_through_the_wrapper_chain`.

The fallback is gated on the CTranslate2 weights already being cached.
`_auto_prefers_mlx` prefers the GPU exactly when they are *absent*, so an
ungated fallback would hand the take to `WhisperModel(..., download_root=...)`
and fetch ~1.5 GB inside a dictation. With nothing on disk the take re-raises
the original error instead. Pinned by
`test_affinity_fallback_is_refused_when_the_cpu_model_is_not_cached`.

Re-measured at this candidate (2026-11-27, B1 fix card) with the
B1-corrected probe, both shapes exit 0, on
`recording-2026-11-27T05-56-34-896696.wav` sliced to 5s -- not the same clip
as the first table above, whose transcript differs.
`preload-then-transcribe-twice` -> preload 0.54s, dictation B 3.98s,
dictation C 5.41s, no-preload single call 5.53s; all three transcripts
identical (`Hello, Hello my testing hunter.`). The probe now prints the
caller thread each take was driven from *and*
`svara.transcriber._mlx_worker_ident` read after the take, then asserts on
them:

```
OK   transcribe B on caller thread 481905111040, MLX worker thread 6140194816 (3.98s) 'Hello, Hello my testing hunter.'
OK   transcribe C on caller thread 481905111040, MLX worker thread 6140194816 (5.41s) 'Hello, Hello my testing hunter.'
OK   confinement: MLX worker thread 6140194816 ran takes B and C; caller threads 481905111040 / 481905111040 both differ from it; degradation records 0; transcripts identical True
```

Both takes ran on the one recorded MLX worker thread (6140194816), distinct
from the caller thread of each take, and the CPU-fallback guard logged
nothing. The caller idents are equal because macOS recycles them across the
two fresh threads -- which is exactly why the old probe's line looked like
proof of a shared worker. The same script run against base `be5ba11` in a
scratch worktree (script copied in, base `svara/` left untouched) exits 1
with `FAIL transcribe B: Transcription failed: There is no Stream(gpu, 1) in
current thread.` Candidate gates here: `pytest tests -q` 156 passed
(154 at `17c384f` + 2 new), `--self-test` 6/6. With the cache-gated fallback
added on top, 157 passed, `--self-test` 6/6, and the probe re-run on
`recording-2026-11-27T09-25-27-150619.wav` exits 0 (worker 6107344896 for
both takes, 2.21s / 2.06s, identical transcripts).

### Still outstanding

The fullscreen banner fix cannot be verified headlessly. It needs a human to go
fullscreen in a real app and dictate, confirming the banner shows both while
transcribing and for the result.

Nothing from the second review is outstanding: the `--transcribe` GPU-routing
bug, the `pt-BR` tokenizer rejection, the stuck download progress bar, and the
two false accuracy claims (README and transcriber docstring) were fixed in
`a314c1a` and `72d31fd`, with tests pinning the routing and tokenizer fixes.
One new finding from the 2026-11-26 re-run is open but out of scope here: the
CPU path's hardcoded `vad_filter=True` rejects very faint clips and returns an
empty transcript (present since `79b1137`; neither introduced nor fixed by
this plan).
