from pathlib import Path

from svara.ui.main_window import AUDIO_SUFFIXES, MainWindow


class _Url:
    def __init__(self, path: Path) -> None:
        self._path = path

    def isLocalFile(self) -> bool:
        return True

    def toLocalFile(self) -> str:
        return str(self._path)


class _Mime:
    def __init__(self, paths) -> None:
        self._urls = [_Url(Path(path)) for path in paths]

    def hasUrls(self) -> bool:
        return bool(self._urls)

    def urls(self):
        return self._urls


def test_dropped_audio_accepts_supported_file(tmp_path):
    audio = tmp_path / "meeting.wav"
    audio.write_bytes(b"x" * 100)
    assert MainWindow._dropped_audio(_Mime([audio])) == audio


def test_dropped_audio_ignores_other_files(tmp_path):
    note = tmp_path / "notes.txt"
    note.write_text("hello", encoding="utf-8")
    assert MainWindow._dropped_audio(_Mime([note])) is None


def test_dropped_audio_skips_missing_file(tmp_path):
    missing = tmp_path / "gone.mp3"
    assert MainWindow._dropped_audio(_Mime([missing])) is None


def test_audio_suffixes_cover_common_formats():
    for suffix in (".wav", ".mp3", ".m4a", ".flac"):
        assert suffix in AUDIO_SUFFIXES
