#!/usr/bin/env python3
"""Reproduce the production preload/transcribe thread shape headlessly.

The app preloads the speech model on one QThread and transcribes on another.
On the MLX backend that shape failed every dictation with

    Transcription failed: There is no Stream(gpu, 1) in current thread.

because mlx_whisper caches its model process-globally and the model's compute
state belongs to the thread that first materialised it: loading on one thread
and evaluating on another raises from mx.async_eval. The fix confines both to
one dedicated process-wide thread (svara.transcriber._run_on_mlx_worker);
this probe drives the exact failing shape against a real Transcriber, so the
defect cannot hide.

``scripts/bench_dictation.py`` cannot see the defect: it preloads and
transcribes on one thread. Exit code 0 with transcript text means the shape
works *and* that confinement held: every take prints the caller thread it ran
on and ``svara.transcriber._mlx_worker_ident`` (the thread MLX actually ran
on), and afterwards the worker ident must be recorded, identical after both
takes and different from both caller idents, with no CPU-fallback guard
record ("GPU transcription hit a stream owned by another thread") logged
while the takes ran. Any of those failing prints ``FAIL confinement ...`` and
exits non-zero; a printed error and a non-zero exit mean the shape itself did
not work -- on the base commit this script fails with the production error
string.

    python3 scripts/probe_mlx_preload_threads.py --shape preload-then-transcribe
    python3 scripts/probe_mlx_preload_threads.py --shape preload-then-transcribe-twice
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

DEFAULT_AUDIO = Path("/Volumes/personal/meetings/recordings")
SHAPES = ("preload-then-transcribe", "preload-then-transcribe-twice")

#: Scope and message of the CPU-fallback guard in ``transcribe_result``. A
#: record like this during a take means the GPU work silently ran somewhere
#: else and was finished on the CPU -- the defect this probe exists for.
DEGRADATION_SCOPE = "transcription"
DEGRADATION_MESSAGE = "GPU transcription hit a stream owned by another thread"


def newest_recording(directory: Path) -> Path:
    candidates = sorted(directory.glob("*.wav"), key=lambda item: item.stat().st_mtime)
    if not candidates:
        raise SystemExit(f"no .wav recordings in {directory}; pass --audio")
    return candidates[-1]


def slice_wav(source: Path, seconds: float, destination: Path) -> Path:
    with wave.open(str(source), "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        frames = handle.readframes(int(rate * seconds))
    with wave.open(str(destination), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(width)
        handle.setframerate(rate)
        handle.writeframes(frames)
    return destination


def run_in_fresh_thread(work: Callable[[], Any]) -> tuple[Any, int]:
    """Run *work* on a brand-new thread; return ``(value, thread_ident)``."""
    box: dict[str, Any] = {}

    def target() -> None:
        box["thread"] = threading.get_ident()
        try:
            box["value"] = work()
        except BaseException as error:  # noqa: BLE001 - reported by the caller
            box["error"] = error

    thread = threading.Thread(target=target)
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box["value"], box["thread"]


class _RecordingLogger:
    """Wraps svara's logger and keeps every ``(scope, message)`` record."""

    def __init__(self, wrapped: Any) -> None:
        self._wrapped = wrapped
        self.records: list[tuple[str, str]] = []

    def error(self, scope: str, message: str, error: Any = None) -> None:
        self.records.append((scope, message))
        self._wrapped.error(scope, message, error)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._wrapped, name)


def capture_log_records() -> _RecordingLogger | None:
    """Route ``svara.transcriber``'s log calls through a recorder.

    ``transcriber`` binds ``get_logger`` into its own namespace, so the hook
    has to be replaced there rather than on ``logging_setup``. Returns
    ``None`` on the base commit, which has no guard and no logger hook.
    """
    import svara.transcriber as transcriber

    getter = getattr(transcriber, "get_logger", None)
    if getter is None:
        return None
    recorder = _RecordingLogger(getter())
    transcriber.get_logger = lambda: recorder
    return recorder


def read_mlx_worker_ident() -> int | None:
    """``svara.transcriber._mlx_worker_ident``, or ``None`` if it never ran.

    Read with ``getattr`` so this probe still runs against the base commit,
    where the dedicated MLX worker does not exist yet.
    """
    import svara.transcriber as transcriber

    return getattr(transcriber, "_mlx_worker_ident", None)


def check_confinement(
    takes: list[tuple[str, int, int | None]],
    records: list[tuple[str, str]],
) -> tuple[int | None, int, str | None]:
    """Verify the MLX work really ran on the dedicated worker thread.

    ``takes`` carries ``(label, caller_ident, worker_ident)`` per dictation:
    ``caller_ident`` is the thread ``run_in_fresh_thread`` spawned, while
    ``worker_ident`` is ``_mlx_worker_ident`` read *after* the take -- the
    thread MLX actually ran on. ``records`` are the log records captured
    while the takes ran.

    Returns ``(worker_ident, degradation_count, failure)``: the worker thread,
    how many scope-``transcription`` guard records were logged, and the
    failure reason (``None`` when confinement held).
    """
    problems: list[str] = []
    workers = [worker for _label, _caller, worker in takes]
    worker_ident = workers[0] if workers else None
    if any(worker is None for worker in workers):
        problems.append(f"_mlx_worker_ident not recorded: {workers}")
    elif len(set(workers)) != 1:
        problems.append(f"MLX worker thread changed between takes: {workers}")
    else:
        for label, caller_ident, _worker in takes:
            if caller_ident == worker_ident:
                problems.append(
                    f"{label} caller thread {caller_ident} is the MLX worker thread"
                )
    degraded = [
        (scope, message)
        for scope, message in records
        if scope == DEGRADATION_SCOPE and DEGRADATION_MESSAGE in message
    ]
    if degraded:
        problems.append(f"CPU-fallback guard logged {len(degraded)} time(s)")
    return worker_ident, len(degraded), "; ".join(problems) or None


def build_transcriber():
    from svara.settings import Settings
    from svara.transcriber import DEFAULT_MODEL_REPO, Transcriber

    settings = Settings()
    return Transcriber(
        model_repo=settings.model_repo or DEFAULT_MODEL_REPO,
        cache_dir=settings.stt_cache_dir,
        backend="auto",
    )


def single_call_timing(args: argparse.Namespace) -> int:
    """One cold call, no preload, on this thread -- the no-preload baseline.

    Runs in a subprocess because mlx_whisper's model cache is process-global:
    in the main probe process the model is already loaded, so an in-process
    "no-preload" call would silently time only the decode.
    """
    from svara.transcriber import TranscriptionError

    transcriber = build_transcriber()
    with tempfile.TemporaryDirectory(prefix="svara-probe-") as temporary:
        clip = slice_wav(Path(args.audio), args.clip, Path(temporary) / "clip.wav")
        started = time.perf_counter()
        try:
            result = transcriber.transcribe_result(clip)
        except TranscriptionError as error:
            print(f"FAIL no-preload call: {error}", file=sys.stderr)
            return 1
        elapsed = time.perf_counter() - started
    print(f"no-preload single call {elapsed:.2f}s  text={result.text!r}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--shape",
        choices=SHAPES,
        default="preload-then-transcribe",
        help="thread shape to drive (default: preload-then-transcribe)",
    )
    parser.add_argument(
        "--audio",
        type=Path,
        help="a recording to slice (default: newest .wav in the recordings folder)",
    )
    parser.add_argument(
        "--clip", type=float, default=5.0, help="clip length in seconds (default 5)"
    )
    parser.add_argument(
        "--_single-call-timing",
        action="store_true",
        help=argparse.SUPPRESS,  # internal: re-executed as a subprocess
    )
    args = parser.parse_args()

    if args._single_call_timing:
        return single_call_timing(args)

    source = args.audio or newest_recording(DEFAULT_AUDIO)
    with tempfile.TemporaryDirectory(prefix="svara-probe-") as temporary:
        clip = slice_wav(Path(source), args.clip, Path(temporary) / "clip.wav")
        transcriber = build_transcriber()
        with_timing = args.shape == "preload-then-transcribe-twice"
        print(f"audio    {Path(source).name} @ {args.clip:g}s")
        print(f"backend  {'mlx' if transcriber.use_mlx else 'cpu'} ({transcriber.active_repo})")

        # Phase A: preload on this thread, the way _PreloadWorker materialises
        # the model before the first dictation.
        started = time.perf_counter()
        try:
            transcriber.preload()
        except Exception as error:  # noqa: BLE001 - probe reports it verbatim
            print(f"FAIL preload: {error}", file=sys.stderr)
            return 1
        preload_seconds = time.perf_counter() - started
        timing = f" ({preload_seconds:.2f}s)" if with_timing else ""
        print(f"OK   preload on thread {threading.get_ident()}{timing}")

        # Phases B and C: transcribe on two *fresh* threads, the way every
        # _TranscribeWorker does after the preload thread has run. Each take
        # records the caller thread (what run_in_fresh_thread spawned) and
        # _mlx_worker_ident read afterwards (the thread MLX ran on), plus any
        # log record the CPU-fallback guard emits while it runs.
        recorder = capture_log_records()
        takes: list[tuple[str, int, int | None]] = []
        transcripts: dict[str, str] = {}
        for label in ("B", "C"):
            started = time.perf_counter()
            try:
                result, caller_ident = run_in_fresh_thread(
                    lambda: transcriber.transcribe_result(clip)
                )
            except Exception as error:  # noqa: BLE001 - probe reports it verbatim
                print(f"FAIL transcribe {label}: {error}", file=sys.stderr)
                return 1
            worker_ident = read_mlx_worker_ident()
            takes.append((label, caller_ident, worker_ident))
            transcripts[label] = result.text
            elapsed = time.perf_counter() - started
            timing = f" ({elapsed:.2f}s)" if with_timing else ""
            print(
                f"OK   transcribe {label} on caller thread {caller_ident}, "
                f"MLX worker thread {worker_ident}{timing} {result.text!r}"
            )

        worker_ident, degraded, failure = check_confinement(
            takes, recorder.records if recorder is not None else []
        )
        if failure is not None:
            print(f"FAIL confinement {failure}", file=sys.stderr)
            return 1
        print(
            f"OK   confinement: MLX worker thread {worker_ident} ran takes B and C; "
            f"caller threads {takes[0][1]} / {takes[1][1]} both differ from it; "
            f"degradation records {degraded}; transcripts identical "
            f"{transcripts['B'] == transcripts['C']}"
        )

        if with_timing:
            completed = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--_single-call-timing",
                    "--audio",
                    str(source),
                    "--clip",
                    str(args.clip),
                ],
                capture_output=True,
                text=True,
                timeout=600,
            )
            line = completed.stdout.strip().splitlines()[-1] if completed.stdout.strip() else ""
            if completed.returncode != 0:
                print(
                    f"FAIL no-preload baseline: {line or completed.stderr.strip()}",
                    file=sys.stderr,
                )
                return 1
            print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
