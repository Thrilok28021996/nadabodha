"""Global dictation: a system-wide hotkey that records and hands the take back.

The hotkey is registered with Carbon (``RegisterEventHotKey``), which needs no
Accessibility permission and dispatches on the Qt main thread. If Carbon cannot
register it, the controller falls back to pynput's global listener, which does
require Accessibility; that state is reported instead of failing silently.

The hotkey callback re-enters the GUI thread through a queued Qt signal before
touching the recorder or the window.
"""

from __future__ import annotations

from PySide6.QtCore import QObject, Qt, Signal

from .hotkey import CarbonHotkey
from .macos import accessibility_trusted
from .recorder import Recorder, RecorderError


class DictationController(QObject):
    """Toggles dictation recording from a global hotkey or the UI."""

    started = Signal()
    finished = Signal(str)
    failed = Signal(str)
    listening_changed = Signal(bool, str)

    _toggle_requested = Signal()

    def __init__(self, recorder: Recorder, hotkey: str = "<alt>+<space>", parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._recorder = recorder
        self._hotkey = hotkey
        self._listener = None
        self._dictating = False
        self._can_start = None
        self._toggle_requested.connect(self.toggle, Qt.ConnectionType.QueuedConnection)

    def set_guard(self, can_start) -> None:  # type: ignore[no-untyped-def]
        """Install a callback that must return True before a take may begin."""
        self._can_start = can_start

    # -- state -------------------------------------------------------------

    @property
    def dictating(self) -> bool:
        return self._dictating

    @property
    def listening(self) -> bool:
        return self._listener is not None

    @property
    def hotkey(self) -> str:
        return self._hotkey

    # -- hotkey ------------------------------------------------------------

    def apply(self, hotkey: str, enabled: bool) -> None:
        self.stop_listening()
        self._hotkey = (hotkey or "<alt>+<space>").strip()
        if enabled:
            self.start_listening()

    def start_listening(self) -> None:
        if self._listener is not None:
            return
        # Preferred: Carbon hotkey, no Accessibility permission required.
        try:
            hotkey = CarbonHotkey(self._hotkey, self._request_toggle)
            hotkey.start()
            self._listener = hotkey
            self.listening_changed.emit(True, "")
            return
        except Exception as carbon_error:  # noqa: BLE001 - falls back below
            carbon_detail = str(carbon_error)
        # Fallback: pynput's event tap needs Accessibility permission.
        if not accessibility_trusted():
            self.listening_changed.emit(
                False,
                f"Global hotkey unavailable ({carbon_detail}). "
                "Grant Accessibility for the fallback hotkey.",
            )
            return
        try:
            from pynput import keyboard
        except ImportError as error:
            self.listening_changed.emit(False, f"Global hotkey needs pynput: {error}")
            return
        try:
            listener = keyboard.GlobalHotKeys({self._hotkey: self._request_toggle})
            listener.start()
        except Exception as error:  # noqa: BLE001 - reported to the UI
            self.listening_changed.emit(False, f"Global hotkey unavailable: {error}")
            return
        self._listener = listener
        self.listening_changed.emit(True, "")

    def stop_listening(self) -> None:
        listener, self._listener = self._listener, None
        if listener is not None:
            try:
                listener.stop()
            except Exception:  # noqa: BLE001 - stopping a dead listener is harmless
                pass

    def _request_toggle(self) -> None:
        self._toggle_requested.emit()

    # -- recording ---------------------------------------------------------

    def toggle(self) -> None:
        if self._dictating:
            self.finish()
            return
        if self._recorder.is_recording:
            # Another recording is in flight; never hijack it.
            return
        self.begin()

    def begin(self) -> None:
        if self._dictating or self._recorder.is_recording:
            return
        if self._can_start is not None and not self._can_start():
            return
        try:
            self._recorder.start()
        except RecorderError as error:
            self.failed.emit(str(error))
            return
        self._dictating = True
        self.started.emit()

    def finish(self) -> None:
        if not self._dictating:
            return
        self._dictating = False
        try:
            recorded = self._recorder.stop()
        except RecorderError as error:
            self.failed.emit(str(error))
            return
        self.finished.emit(str(recorded))

    def cancel(self) -> None:
        if self._dictating:
            self._dictating = False
            self._recorder.cancel()
        self.stop_listening()
