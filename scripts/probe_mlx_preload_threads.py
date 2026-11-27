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
works; a printed error and a non-zero exit mean it does not -- on the base
commit this script fails with the production error string.

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
        # _TranscribeWorker does after the preload thread has run.
        for label in ("B", "C"):
            started = time.perf_counter()
            try:
                result, worker_ident = run_in_fresh_thread(
                    lambda: transcriber.transcribe_result(clip)
                )
            except Exception as error:  # noqa: BLE001 - probe reports it verbatim
                print(f"FAIL transcribe {label}: {error}", file=sys.stderr)
                return 1
            elapsed = time.perf_counter() - started
            timing = f" ({elapsed:.2f}s)" if with_timing else ""
            print(f"OK   transcribe {label} on thread {worker_ident}{timing} {result.text!r}")

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
