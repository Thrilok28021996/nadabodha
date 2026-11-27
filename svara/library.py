"""Read the generated recordings/transcripts/summaries as a browsable library."""

from __future__ import annotations

import wave
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

FOLDERS = ("recordings", "transcripts", "summaries")
KIND_BY_SUFFIX = {".wav": "Recording", ".txt": "Transcript", ".md": "Summary"}


@dataclass(frozen=True)
class LibraryItem:
    kind: str
    path: Path
    modified: float
    size: int
    duration: float | None = None

    @property
    def name(self) -> str:
        return self.path.name

    @property
    def when(self) -> datetime:
        return datetime.fromtimestamp(self.modified)

    @property
    def detail(self) -> str:
        if self.duration is not None:
            minutes, seconds = divmod(int(self.duration), 60)
            return f"{minutes}:{seconds:02d} · {self.size / 1e6:.1f} MB"
        return f"{self.size / 1000:.0f} kB"


def _wav_duration(path: Path) -> float | None:
    try:
        with wave.open(str(path), "rb") as handle:
            rate = handle.getframerate()
            frames = handle.getnframes()
    except (wave.Error, EOFError, OSError):
        return None
    if not rate:
        return None
    return frames / float(rate)


def scan_library(root: Path, limit: int = 300) -> list[LibraryItem]:
    root = Path(root)
    items: list[LibraryItem] = []
    for folder in FOLDERS:
        directory = root / folder
        if not directory.is_dir():
            continue
        try:
            entries = list(directory.iterdir())
        except OSError:
            continue
        for path in entries:
            if not path.is_file():
                continue
            kind = KIND_BY_SUFFIX.get(path.suffix.lower())
            if kind is None:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            items.append(
                LibraryItem(
                    kind=kind,
                    path=path,
                    modified=stat.st_mtime,
                    size=stat.st_size,
                    duration=_wav_duration(path) if kind == "Recording" else None,
                )
            )
    items.sort(key=lambda item: item.modified, reverse=True)
    return items[:limit]
