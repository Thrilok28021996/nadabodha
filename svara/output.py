"""Writes generated files into the user's output folder.

Layout under the configured output directory (default
``/Volumes/personal/meetings``)::

    recordings/recording-<timestamp>.wav
    transcripts/transcript-<timestamp>.txt
    summaries/summary-<timestamp>.md

Every function creates its directory, never overwrites an existing file, and
raises ``OutputError`` when the folder is unavailable (e.g. an unmounted
volume), so the caller can fall back and tell the user.
"""

from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path


class OutputError(RuntimeError):
    """The output folder could not be created or written."""


def _stamp(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H-%M-%S-%f")


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    suffix = 1
    stem, extension = path.stem, path.suffix
    while True:
        candidate = path.with_name(f"{stem}-{suffix}{extension}")
        if not candidate.exists():
            return candidate
        suffix += 1


def ensure_output_root(root: Path) -> Path:
    root = Path(root).expanduser()
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise OutputError(f"Output folder is unavailable: {root} ({error})") from error
    return root


def _write_text(path: Path, text: str) -> Path:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        target = _unique(path)
        target.write_text(text, encoding="utf-8")
    except OSError as error:
        raise OutputError(f"Could not write {path}: {error}") from error
    return target


def save_recording(source: Path, root: Path, now: datetime | None = None) -> Path:
    source = Path(source)
    root = ensure_output_root(root)
    if not source.is_file() or source.stat().st_size <= 0:
        raise OutputError("Recording file is empty or unavailable")
    try:
        destination = _unique(root / "recordings" / f"recording-{_stamp(now)}.wav")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    except OSError as error:
        raise OutputError(f"Could not save the recording: {error}") from error
    return destination


def save_transcript(root: Path, text: str, now: datetime | None = None) -> Path:
    root = ensure_output_root(root)
    if not text.strip():
        raise OutputError("Transcript is empty")
    return _write_text(root / "transcripts" / f"transcript-{_stamp(now)}.txt", text)


def save_summary(root: Path, text: str, now: datetime | None = None) -> Path:
    root = ensure_output_root(root)
    if not text.strip():
        raise OutputError("Summary is empty")
    return _write_text(root / "summaries" / f"summary-{_stamp(now)}.md", text)
