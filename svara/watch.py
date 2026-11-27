"""Watch-folder import: transcribe audio files dropped into a folder.

Only files that appear (or grow) after the folder is configured are imported;
existing files are snapshotted and ignored so restarting the app does not
re-transcribe a whole archive. A file must keep the same size across two scans
before it is handed to the transcriber, which avoids reading a copy still in
progress.
"""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QFileSystemWatcher, QObject, QTimer, Signal

AUDIO_SUFFIXES = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac", ".aiff", ".wma"}
MIN_BYTES = 44
SCAN_MS = 3000


class WatchFolder(QObject):
    file_ready = Signal(str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._watcher = QFileSystemWatcher(self)
        self._watcher.directoryChanged.connect(self._on_directory_changed)
        self._timer = QTimer(self)
        self._timer.setInterval(SCAN_MS)
        self._timer.timeout.connect(self._scan)
        self._folder: Path | None = None
        self._known: dict[Path, tuple[int, int]] = {}
        self._announced: set[Path] = set()

    @property
    def folder(self) -> Path | None:
        return self._folder

    def set_folder(self, folder: str) -> None:
        self.stop()
        configured = (folder or "").strip()
        if not configured:
            return
        path = Path(configured).expanduser()
        if not path.is_dir():
            return
        self._folder = path
        self._watcher.addPath(str(path))
        self._scan(snapshot_only=True)
        self._timer.start()

    def stop(self) -> None:
        self._timer.stop()
        if self._folder is not None:
            try:
                self._watcher.removePath(str(self._folder))
            except Exception:  # noqa: BLE001 - already removed
                pass
        self._folder = None
        self._known = {}
        self._announced = set()

    def _on_directory_changed(self, _path: str) -> None:
        # The poll timer handles the stability check; this just shortens the
        # wait when the OS reports a change.
        self._scan()

    def _scan(self, snapshot_only: bool = False) -> None:
        folder = self._folder
        if folder is None or not folder.is_dir():
            return
        try:
            entries = list(folder.iterdir())
        except OSError:
            return
        for path in entries:
            if not path.is_file() or path.suffix.lower() not in AUDIO_SUFFIXES:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            if stat.st_size < MIN_BYTES:
                continue
            signature = (stat.st_size, int(stat.st_mtime))
            if path not in self._known:
                self._known[path] = signature
                if snapshot_only:
                    # Files already in the folder when watching starts are
                    # never imported; otherwise a restart would replay them.
                    self._announced.add(path)
                continue
            if self._known[path] != signature:
                self._known[path] = signature
                continue
            if snapshot_only or path in self._announced:
                continue
            self._announced.add(path)
            self.file_ready.emit(str(path))
