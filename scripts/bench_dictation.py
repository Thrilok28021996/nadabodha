#!/usr/bin/env python3
"""Measure dictation latency on real audio, so speed claims stay checkable.

A dictation take is short, and Whisper pads every clip to a 30 second window,
so dictation latency is dominated by fixed per-call cost rather than audio
length. This measures the three parts a user actually feels:

    load      first-call model load (paid once per app launch)
    transcribe  one call, the thing between "stop" and text at the cursor
    total     load + transcribe, i.e. a cold dictation

Run it before and after a change, on the same file, and compare. It also gates
the MLX backend: same audio, both backends, whichever is faster wins.

    python3 scripts/bench_dictation.py --clip 5 --runs 3
    python3 scripts/bench_dictation.py --clip 5 --language en --no-timestamps
    python3 scripts/bench_dictation.py --clip 5 --backend mlx
"""

from __future__ import annotations

import argparse
import statistics
import sys
import tempfile
import time
import wave
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

DEFAULT_AUDIO = Path("/Volumes/personal/meetings/recordings")


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


def build_transcriber(backend: str, model_repo: str, cache_dir: str):
    from svara.transcriber import Transcriber

    return Transcriber(model_repo=model_repo, cache_dir=cache_dir, backend=backend)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, help="a recording to slice (default: newest in the output folder)")
    parser.add_argument("--clip", type=float, default=5.0, help="clip length in seconds (default 5)")
    parser.add_argument("--runs", type=int, default=3, help="timed runs after the first (default 3)")
    parser.add_argument("--language", default="", help="language code passed through; empty means auto-detect")
    parser.add_argument(
        "--no-timestamps",
        action="store_true",
        help="pass without_timestamps=True, as the dictation path will",
    )
    parser.add_argument("--backend", default="cpu", choices=["cpu", "mlx"])
    parser.add_argument("--model", default="", help="override the model repo")
    parser.add_argument("--cache-dir", default="", help="override the model cache directory")
    parser.add_argument("--text", action="store_true", help="print the transcript so runs can be diffed")
    args = parser.parse_args()

    from svara.transcriber import DEFAULT_MODEL_REPO
    from svara.settings import Settings

    settings = Settings()
    model_repo = args.model or settings.model_repo or DEFAULT_MODEL_REPO
    cache_dir = args.cache_dir or settings.stt_cache_dir

    source = args.audio or newest_recording(DEFAULT_AUDIO)
    with tempfile.TemporaryDirectory(prefix="svara-bench-") as temporary:
        clip = slice_wav(Path(source), args.clip, Path(temporary) / "clip.wav")
        transcriber = build_transcriber(args.backend, model_repo, cache_dir)
        active_repo = getattr(transcriber, "active_repo", model_repo)

        # Report the load separately when the transcriber exposes it, otherwise
        # the first call absorbs it and shows up as the cold run.
        load: float | None = None
        preload = getattr(transcriber, "preload", None)
        if callable(preload):
            started = time.perf_counter()
            preload()
            load = time.perf_counter() - started

        # Only forward knobs that are switched on, so the script runs against
        # the pre-change code too (defaults then reproduce today's behaviour).
        kwargs: dict[str, object] = {}
        if args.language:
            kwargs["language"] = args.language
        if args.no_timestamps:
            kwargs["without_timestamps"] = True
        timings: list[float] = []
        text = ""
        for _ in range(args.runs):
            started = time.perf_counter()
            result = transcriber.transcribe_result(clip, **kwargs)
            timings.append(time.perf_counter() - started)
            text = result.text

    cold, warm = timings[0], timings[1:] or timings
    config = f"language={args.language or 'auto'} timestamps={'off' if args.no_timestamps else 'on'}"
    print(f"backend     {args.backend}  ({active_repo})")
    print(f"audio       {Path(source).name} @ {args.clip:g}s")
    print(f"knobs       {config}")
    if load is not None:
        print(f"load        {load:.2f}s")
    print(f"cold call   {cold:.2f}s   (first dictation after launch)")
    print(f"warm call   median {statistics.median(warm):.2f}s  runs {[round(t, 2) for t in warm]}")
    if args.text:
        print(f"text        {text!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
