from datetime import datetime, timezone

import pytest

from svara.output import (
    OutputError,
    ensure_output_root,
    save_recording,
    save_summary,
    save_transcript,
)

NOW = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)


def test_ensure_output_root_creates_directory(tmp_path):
    root = tmp_path / "meetings"
    assert ensure_output_root(root) == root
    assert root.is_dir()


def test_save_recording_copies_into_recordings(tmp_path):
    source = tmp_path / "temp.wav"
    source.write_bytes(b"audio")
    root = tmp_path / "meetings"
    saved = save_recording(source, root, now=NOW)
    assert saved == root / "recordings" / "recording-2026-01-02T03-04-05-000000.wav"
    assert saved.read_bytes() == b"audio"


def test_save_recording_rejects_empty_source(tmp_path):
    source = tmp_path / "empty.wav"
    source.write_bytes(b"")
    with pytest.raises(OutputError):
        save_recording(source, tmp_path / "meetings")


def test_save_transcript_writes_text_file(tmp_path):
    saved = save_transcript(tmp_path / "meetings", "hello world", now=NOW)
    assert saved.parent.name == "transcripts"
    assert saved.suffix == ".txt"
    assert saved.read_text(encoding="utf-8") == "hello world"


def test_save_summary_writes_markdown(tmp_path):
    saved = save_summary(tmp_path / "meetings", "## Summary", now=NOW)
    assert saved.parent.name == "summaries"
    assert saved.suffix == ".md"
    assert saved.read_text(encoding="utf-8") == "## Summary"


def test_same_timestamp_never_overwrites(tmp_path):
    root = tmp_path / "meetings"
    first = save_transcript(root, "one", now=NOW)
    second = save_transcript(root, "two", now=NOW)
    assert first != second
    assert second.name.endswith("-1.txt")


def test_empty_text_is_rejected(tmp_path):
    with pytest.raises(OutputError):
        save_transcript(tmp_path / "meetings", "   ")
    with pytest.raises(OutputError):
        save_summary(tmp_path / "meetings", "")


def test_unavailable_root_raises_output_error(tmp_path):
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory")
    with pytest.raises(OutputError):
        ensure_output_root(blocker / "meetings")
