from PySide6.QtCore import QCoreApplication

from svara.watch import WatchFolder


def _app():
    return QCoreApplication.instance() or QCoreApplication([])


def test_existing_files_are_not_reimported(tmp_path):
    _app()
    folder = tmp_path / "inbox"
    folder.mkdir()
    (folder / "old.wav").write_bytes(b"x" * 200)
    watch = WatchFolder()
    received = []
    watch.file_ready.connect(received.append)
    watch.set_folder(str(folder))
    watch._scan()
    assert received == []


def test_new_file_is_announced_after_it_stabilises(tmp_path):
    _app()
    folder = tmp_path / "inbox"
    folder.mkdir()
    watch = WatchFolder()
    received = []
    watch.file_ready.connect(received.append)
    watch.set_folder(str(folder))
    new = folder / "meeting.wav"
    new.write_bytes(b"y" * 200)
    watch._scan()
    assert received == []  # first sighting only records the size
    watch._scan()
    assert received == [str(new)]
    watch._scan()
    assert received == [str(new)]  # announced only once


def test_growing_file_waits_for_a_stable_size(tmp_path):
    _app()
    folder = tmp_path / "inbox"
    folder.mkdir()
    watch = WatchFolder()
    received = []
    watch.file_ready.connect(received.append)
    watch.set_folder(str(folder))
    new = folder / "growing.wav"
    new.write_bytes(b"z" * 200)
    watch._scan()
    new.write_bytes(b"z" * 400)
    watch._scan()
    assert received == []
    watch._scan()
    assert received == [str(new)]


def test_non_audio_files_are_ignored(tmp_path):
    _app()
    folder = tmp_path / "inbox"
    folder.mkdir()
    watch = WatchFolder()
    received = []
    watch.file_ready.connect(received.append)
    watch.set_folder(str(folder))
    (folder / "notes.txt").write_text("hello")
    watch._scan()
    watch._scan()
    assert received == []
