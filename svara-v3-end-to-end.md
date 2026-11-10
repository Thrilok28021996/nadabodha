# Svara v3 — End-to-End Plan: One App for Transcription + Dictation (Steno-style UI)

Status: DRAFT — awaiting explicit human approval. No implementation begins before approval.
Planner: factory-planner. Repo: /Volumes/personal/programmingFolders/nadabodha (main @ 5999fdc).
Candidate base for v3: work/nadabodha-ui-dictation @ 48c9f97 (cycle 2, Tester NEEDS_FIX — see Stage 0).

## 1. Goal

Turn Svara into a single local-only macOS app that does BOTH jobs the market currently
splits across two purchases:

- DICTATION: hold ⌥ anywhere in macOS → speak → release → text is INSERTED AT THE CURSOR of
  the focused app (Wispr Flow / Superwhisper / Hold-to-Talk convention), with history kept in
  Svara.
- TRANSCRIPTION: record meetings (mic + system audio), import files, live streaming partial
  results, speaker labels, Markdown summaries, folder-organized note library (MacWhisper +
  Steno convention).

UI: StenoAI (stenoai.co) pattern — dark theme, left sidebar (search ⌘K, nav, folder list with
counts, note list) + main note-detail (title/date, docked recording pill with timer, tabs,
actions).

Hard constraints (unchanged from day 1): NO Swift; TypeScript + Python only; local-only —
network confined to 127.0.0.1 + huggingface.co (+ package managers for dependency installs);
HF_HOME=/Volumes/personal/huggingface must stay byte-identical across test runs; pipeline is
Builder → Tester (exact SHA, isolated worktree) → at most ONE bounded fix + rerun → Reviewer →
human merge decision; never merge/push without explicit approval.

## 2. Research summary (what we adopt, and from whom)

Dictation market (Wispr Flow $15/mo cloud, Superwhisper $8.49/mo local, Hold to Talk,
TranscribeNext, Voibe $149-169, Apple Dictation free):
- Universal convention: hold a hotkey → speak → release → text lands at the focused caret.
  THIS is what "dictation" means to users; appending in-app only (our cycle-2 behavior) reads
  as incomplete. → Adopt insert-at-cursor (user decision: insert-at-cursor, system-wide).
- Differentiators are hotkey ergonomics, auto-edit prompts, and workflow integration — not the
  Whisper model. Local-only + free is our positioning gap ("free, private, simple" is called
  out by reviewers as unfilled).
- Wispr/TranscribeNext bind bare Fn; we already ship bare-⌥ with chord-cancel — keep it, it
  prevents shortcut hijacking (⌥+arrow etc.).

Transcription market (MacWhisper €64 lifetime files-first, StenoAI open-source meetings,
Granola/Otter cloud):
- File → text with folders, batch, watch folders, SRT/VTT export, speaker labels.
- Meeting capture via system audio (no meeting bots) + mic; Steno uses per-channel
  [You] vs [Others] labelling live, then optional diarization.
- Markdown ownership: transcripts/summaries are plain .md files you can edit/sync — we already
  do .md autosave; keep it as the storage format for the note library.

StenoAI UI (the chosen visual reference):
- Left rail: Search ⌘K, Home, "All notes <n>", Folders (Work 7, Personal 5 …) with counts.
- Main: note title, "Jun 29, 2026 Started 2:14 PM", Add-to-folder, in-note Notes tab, and a
  docked "Recording · 00:14:22 · Stop" pill that never blocks the note.
- Record → transcribe (verbatim, speaker labels) → summarize (summary/topics/action items) →
  all local; "Coming from Granola" pattern = capture without bots.
- We adopt the LAYOUT and interactions, not their code (MIT-licensed; we write ours).

Technical feasibility verified:
- System audio: `catap` (PyPI 0.6.0) wraps Apple's Core Audio Tap (macOS 14.2+, Python 3.11+;
  our conda env is Python 3.13.12 ✓) — per-app or system mix, multitrack with optional mic
  track, NO Swift, NO virtual driver. Requires TCC "Screen & System Audio Recording" permission.
- Streaming: whisper_streaming-style LocalAgreement over faster-whisper (1.2.1 already in conda
  env): emit only text confirmed across 2 consecutive windows → low latency, no hallucinated
  rewrites. Partial + final results fit our existing JSON-lines IPC (long-lived adapter mode).
- Insert-at-cursor: clipboard write + synthesized ⌘V via uiohook-napi's keyTap/keyToggle
  (hook_post_event already exists in its addon.c — NO new dependency needed; we already ship
  uiohook-napi 1.5.5 and have Accessibility granted).
- ffmpeg 9.0.2 on PATH; Electron 33.4.11; mic TCC granted (Accessibility was RESET on
  2026-09-29 for the grant-flow hands-on test — re-grant needed before Stage 0 live runs).

## 3. Product shape (target UX)

Shell (Steno-style):
- Sidebar: app mark; Search ⌘K (filters notes + dictation history); primary actions (Record,
  Import, Dictate status); nav (Home, Notes, Dictation log); Folders with note counts; recent
  notes list (title + date + source badge).
- Main: note detail — title (editable), created/started metadata, folder chip; source-specific
  header actions; docked recording pill (timer + Stop) while capturing; tabs Transcript |
  Summary | (per-note) Files; copy/save/export actions; Settings as a slide-over panel (not a
  modal, not a page).
- Global dictation: floating status (badge + live partial text) anchored bottom-right of the
  focused space or in the pill area of our own window; on release text is pasted at the caret
  AND appended to today's Dictation-log note (single source of truth for history).
- Dark theme only, WCAG AA, all existing element IDs preserved or the harness updated in the
  SAME change (never silently dropped).

Note library (new core concept):
- A note = one transcription unit (recording session, imported file, meeting, dictation day
  log). Stored as local files under the chosen data dir: note.md (frontmatter: id, title,
  created, source, folder, duration, model) + summary.md + audio (when recorded).
- Audio persistence is MANDATORY for re-transcribe: recorded WAVs are currently left in
  os.tmpdir() (cleaned only on cancel, then reaped by macOS — audio is effectively lost) and
  are never copied to the data dir. Stage 1 copies the recording into the note's folder on
  successful transcription and removes the temp dir (also fixes the orphaned nadabodha-*
  temp-dir leak). Imported files are copied into the note folder too (user's original file
  is never moved or touched).
- Folder = subdirectory or frontmatter tag (Builder's choice, justify in report; must survive
  user moving files in Finder — reindex on start).
- Search: ⌘K over titles + note bodies (local index; no network).

Capability scope (user-selected): live streaming transcription, system-audio/meeting capture,
speaker labels + batch/export. NOT in scope: ask/chat over notes, cloud sync, accounts, mobile.

## 4. Staged delivery (each stage = one full factory cycle: Builder → Tester → Reviewer → human)

### Stage 0 — Stabilize cycle 2 (prerequisite; already-approved work)
- Fix F3-1 (Tester NEEDS_FIX on 48c9f97): the 10s hook-silence watchdog discards holds >10s
  because macOS never auto-repeats modifier keys — premise is wrong. Keep F1/F2 fixes and the
  error/stop fail-closed listeners; replace the silence heuristic (Builder's choice: drop it,
  or bind loss-of-keyup detection to a signal that actually exists; justify + unit-test).
  Add a permanent long-hold (>10s) assertion to cdp-smoke.
- Run the hands-on checklist (already written:
  factory-planner/cache/scratch/dictation-hands-on-checklist.md), including the REAL
  Accessibility grant flow (permission was reset for this) — human executes, Planner records.
- Harness hardening (promised in cycle 2): attempt-count reporting as pass rate, other-app-
  focused system-wide step, <300ms boundary probes (290/310ms), state-machine vs acoustic
  assertion split.
- Exit: Tester APPROVE on the new SHA → Reviewer MERGE-READY → push branch → create PR #3
  stacked on PR #2 (creation approved in principle; merge still requires human say-so).

### Stage 1 — Steno-style shell + note library
- Restructure renderer to sidebar + note-detail shell (dark, ⌘K search, folders w/ counts,
  recent notes, docked recording pill, settings slide-over). Reuse cycle-2 dark palette.
- Implement the note store (frontmatter .md files, index, reindex-on-start, folder ops,
  create note from recording/import/dictation-log; existing transcripts/summaries import as
  notes on first run — one-time migration, never delete user files).
- Dictation and recording results write into notes instead of a single scratch transcript.
- RE-TRANSCRIBE: a note-detail action "Re-transcribe" that re-runs the existing pipeline on
  the note's stored audio using the currently selected model (no new engine — reuse
  transcriptionService with the note's audio path, replace semantics scoped to that note).
  Requires Stage 1's audio persistence. Flow: button → progress in the note header → old
  transcript replaced only on success (on failure/cancel the previous transcript stays
  intact) → summary marked stale with a "Re-summarize" action → note frontmatter's `model`
  and `transcribed_at` updated. A "keep old transcript" variant (write the new one as
  transcript-v2) is out of scope — replaced-on-success only, justified by the note being the
  single source of truth. Dictation-log notes and text-only notes with no audio show the
  action disabled with an explanatory tooltip.
- Acceptance: all prior IDs present (or harness+code updated together, diffed explicitly);
  ⌘K finds notes offline; migration is non-destructive; record → note created with transcript;
  summary renders as before; 141+ baseline tests green + new note-store unit tests; full CDP
  smoke green (warm); HF fingerprint identical; re-transcribe proven live on a recorded note
  (different model → new transcript, frontmatter updated) and proven safe on failure
  (kill the adapter mid-run → previous transcript unchanged).

### Stage 2 — Dictation v2: insert-at-cursor
- On release: finalize transcript → write to clipboard → synthesize ⌘V at the CURRENT focus
  (uiohook keyTap) → restore previous clipboard after a short delay → append to today's
  Dictation-log note. Guard rails: detect secure-input fields (kSecureInputState) and skip
  paste (keep in-app only + notice); never paste while OUR window has focus without
  confirmation setting; app-focus restore if we ever took focus.
- Setting: paste-at-cursor ON by default, OFF = append-in-app only (escape hatch).
- Live partial text while holding: placeholder indicator in Stage 2; wiring it to real
  partials lands as a small follow-up once Stage 3 (streaming) exists — stages are
  sequential, so Stage 2 cannot depend on Stage 3.
- F3-1's long-hold fix + real-key semantics re-verified with hands-on checklist pass #2
  (physical ⌥, other app focused — the exact gap you flagged).
- Acceptance: paste lands in TextEdit/Notes/Slack-in-browser/VS Code (≥3 real apps, human
  spot-check + CDP where possible); chord/tap/off paths unchanged; clipboard restored;
  Dictation-log note accumulates; unit tests for paste state machine; no new deps.

### Stage 3 — Live streaming transcription
- Long-lived Python adapter mode: raw PCM (s16le/16k) chunks on stdin → faster-whisper with
  VAD + LocalAgreement-2 → JSON-lines {partial|final} events on stdout (matches existing
  IPC). ffmpeg tees mic capture to WAV file (record-of-truth) + PCM stream.
- Renderer: partial text renders live (dimmed) in transcript/note and dictation badge;
  finals commit; cancel/stop semantics preserved; final full-file pass optional (accuracy
  check) — Builder justifies whether streaming text is final or re-verified at stop.
- Model: tiny/base for streaming latency vs existing selected model for file jobs; chosen
  model must already be in HF_HOME or downloaded via our HF browser to HF_HOME (byte-count
  grows only by explicit user download — test runs must not silently download; assert).
- Acceptance: partials appear within ~2s of speech; final text equals-or-beats current
  batch result on speech.wav sample; no console errors; cancel during streaming leaves no
  orphan adapter process; unit tests over a fake adapter emitter; HF fingerprint rule honored.

### Stage 4 — System audio + meeting capture + channel speaker labels
- Add `catap` to python requirements (PyPI one-time install; conda env). Record mic (existing
  avfoundation path) + system mix (catap) simultaneously as two tracks.
- Meeting mode: one note, two channels → transcript with [You] (mic) / [Others] (system)
  labels; per Steno convention label live if streaming landed, else post-hoc merge.
- TCC: guide user through "Screen & System Audio Recording" grant (banner pattern like the
  dictation one); app must fail closed + explain if denied (no crash).
- Acceptance: two-track capture is sample-aligned enough to merge labels sanely (state
  tolerance); Zoom/Safari audio + mic captured in a real meeting-like test; permission-denied
  path proven; no Swift/loopback driver; existing mic-only flow untouched.

### Stage 5 — Batch, watch folder, exports
- Multi-file import queue with per-item progress/cancel (reuse download-progress UX); watch
  folder (poll, no FSEvents dependency) → auto-note creation; exports: TXT (exists), MD
  (exists), SRT/VTT from word timestamps (faster-whisper), transcript copy per note.
- Acceptance: 5-file batch completes with independent failure isolation; watch folder creates
  notes without dupes; SRT timestamps monotonic; all prior gates green.

## 5. Test strategy (addressing the five gaps the cycle-2 review exposed)

1. Real-hardware tests are HUMAN steps: every stage that touches dictation ships a hands-on
   checklist (physical ⌥, other-app-focused, boundary taps, long hold, real TCC grant). The
   human runs it; Planner records results as evidence for the Tester/Reviewer handoff.
2. Synthetic injection stays for CI-able paths but must be labeled synthetic in reports; a
   "system-wide" claim requires the other-app-focused step.
3. Retry loops must report attempt counts (pass@1 vs pass@N); matcher tightened from /hello/i
   to a multi-word phrase from the known sample.
4. Acoustic assertions split from state-machine assertions (silence/noise must still prove
   recording start/append/cancel deterministically; transcript quality proven separately).
5. Warm/cold LM Studio labeling on every smoke run; cold timeouts are environment, reported
   as such with curl evidence (as cycle 2 did).

## 6. Risks & mitigations

- Paste-at-cursor fragility (secure input, apps ignoring ⌘V, password fields): feature-flag
  with append-only fallback; detect secure input; human spot-check across ≥3 apps in Stage 2.
- catap long-run stability (README: sleep/wake + route changes not covered): meeting mode
  documents the limitation; watchdog re-record like our mic recorder has.
- Scope: 6 stages × full pipeline ≈ multi-day. Stage order is value-first and each stage
  independently shippable; human can stop after any stage.
- Streaming accuracy regressions: final-at-stop re-verification option (Stage 3 acceptance).
- Dependency adds: catap (+ its PyObjC deps) only in Stage 4; no renderer deps ever (sandbox,
  no bundler); uiohook reused for paste (no new npm dep).
- Data safety: note migration is additive; never overwrite existing prompt/transcript files;
  HF_HOME untouched by tests.
- Re-transcribe depends on Stage 1 audio persistence landing first; temp-dir cleanup must not
  delete audio a re-transcribe run is reading (Builder must sequence copy-then-clean and
  cover it with a test).

## 7. Assumptions (flag if wrong)

- PR #2 merges as-is when you approve; PR #3 (cycle 2) stacks on it; v3 stages stack on PR #3.
- "Insert at cursor" is the primary dictation behavior; append-in-app becomes the fallback
  setting (you chose insert-at-cursor; fallback is my design choice for safety).
- Ask/chat over notes excluded (you did not select it).
- Package-manager network (npm/pip/PyPI, huggingface.co) remains acceptable under
  "local-only"; runtime traffic stays 127.0.0.1-only.
- StenoAI is a visual/UX reference only; no code copied.
- macOS 14.2+ acceptable as minimum for system-audio capture (catap); mic dictation still
  works on older versions, feature-gated.

## 8. Open questions for approval

1. Approve this plan as staged (Stage 0 first), or compress stages / reorder?
2. Stage 0's hands-on checklist needs ~10 min of your time (real ⌥ holds + real Accessibility
   re-grant). Are you doing that now, or after plan approval?
