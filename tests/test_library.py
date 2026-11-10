import wave
from pathlib import Path

import numpy as np

from svara.library import LibraryItem, scan_library


def _wav(path: Path, seconds: float = 1.0, rate: int = 16000) -> None:
    samples = np.zeros(int(seconds * rate), dtype=np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(samples.tobytes())


def test_scan_reads_all_three_folders(tmp_path):
    for folder in ("recordings", "transcripts", "summaries"):
        (tmp_path / folder).mkdir()
    _wav(tmp_path / "recordings" / "take.wav", seconds=2)
    (tmp_path / "transcripts" / "talk.txt").write_text("hello", encoding="utf-8")
    (tmp_path / "summaries" / "talk.md").write_text("## Summary", encoding="utf-8")

    items = scan_library(tmp_path)
    kinds = {item.kind for item in items}
    assert kinds == {"Recording", "Transcript", "Summary"}
    recording = next(item for item in items if item.kind == "Recording")
    assert recording.duration == 2.0
    assert "0:02" in recording.detail


def test_scan_sorts_newest_first_and_limits(tmp_path):
    transcripts = tmp_path / "transcripts"
    transcripts.mkdir()
    first = transcripts / "a.txt"
    first.write_text("a", encoding="utf-8")
    second = transcripts / "b.txt"
    second.write_text("b", encoding="utf-8")
    import os
    import time

    os.utime(first, (time.time() - 100, time.time() - 100))
    items = scan_library(tmp_path)
    assert [item.name for item in items] == ["b.txt", "a.txt"]
    assert len(scan_library(tmp_path, limit=1)) == 1


def test_scan_ignores_unknown_files_and_missing_folders(tmp_path):
    (tmp_path / "recordings").mkdir()
    (tmp_path / "recordings" / "notes.pdf").write_text("x", encoding="utf-8")
    assert scan_library(tmp_path) == []
    assert scan_library(tmp_path / "missing") == []


def test_item_detail_uses_kilobytes_for_text():
    item = LibraryItem(kind="Transcript", path=Path("a.txt"), modified=0, size=1500)
    assert item.detail == "2 kB"
