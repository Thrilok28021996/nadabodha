"""System-wide hotkey through Carbon's RegisterEventHotKey.

Unlike a Quartz event tap (pynput), a Carbon hotkey needs no Accessibility
permission, so Option+Space works on a fresh install. The handler is dispatched
on the Qt main thread, which is where the dictation controller expects it.

Hotkey syntax follows pynput's: ``<alt>+<space>``, ``<cmd>+<shift>+r``, etc.
"""

from __future__ import annotations

import ctypes
import itertools
import sys
from typing import Callable

FOURCC_KEYBOARD = 0x6B657962  # 'keyb'
EVENT_HOTKEY_PRESSED = 5
HOTKEY_SIGNATURE = 0x53767261  # 'Svra'
PARAM_DIRECT_OBJECT = 0x2D2D2D2D  # '----'
TYPE_EVENT_HOTKEY_ID = 0x686B6964  # 'hkid'
EVENT_NOT_HANDLED = -9874

_ids = itertools.count(1)

MOD_CMD = 0x0100
MOD_SHIFT = 0x0200
MOD_ALT = 0x0800
MOD_CTRL = 0x1000

_MODIFIERS = {
    "<cmd>": MOD_CMD,
    "<command>": MOD_CMD,
    "<shift>": MOD_SHIFT,
    "<alt>": MOD_ALT,
    "<option>": MOD_ALT,
    "<ctrl>": MOD_CTRL,
    "<control>": MOD_CTRL,
}

_KEYCODES = {
    "<space>": 49,
    "<return>": 36,
    "<enter>": 36,
    "<tab>": 48,
    "<escape>": 53,
    "<esc>": 53,
    "<delete>": 51,
    "<backspace>": 51,
    "<left>": 123,
    "<right>": 124,
    "<down>": 125,
    "<up>": 126,
}

_CHAR_KEYCODES = {
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24,
    "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32,
    "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
    "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
}


class HotkeyError(RuntimeError):
    """The hotkey string is invalid or the system refused the registration."""


def parse_hotkey(hotkey: str) -> tuple[int, int]:
    """Return ``(keycode, carbon_modifier_mask)`` for a pynput-style string."""
    tokens = [token.strip().lower() for token in (hotkey or "").split("+") if token.strip()]
    if not tokens:
        raise HotkeyError("Hotkey is empty")
    modifiers = 0
    keycode: int | None = None
    for token in tokens:
        if token in _MODIFIERS:
            modifiers |= _MODIFIERS[token]
        elif token in _KEYCODES:
            keycode = _KEYCODES[token]
        elif token in _CHAR_KEYCODES:
            keycode = _CHAR_KEYCODES[token]
        elif len(token) == 1 and token in _CHAR_KEYCODES:
            keycode = _CHAR_KEYCODES[token]
        else:
            raise HotkeyError(f"Unsupported hotkey token: {token}")
    if keycode is None:
        raise HotkeyError("Hotkey needs a key, for example <alt>+<space>")
    if modifiers == 0:
        raise HotkeyError("Hotkey needs at least one modifier")
    return keycode, modifiers


class _EventHotKeyID(ctypes.Structure):
    _fields_ = [("signature", ctypes.c_uint32), ("id", ctypes.c_uint32)]


class _EventTypeSpec(ctypes.Structure):
    _fields_ = [("eventClass", ctypes.c_uint32), ("eventKind", ctypes.c_uint32)]


_CALLBACK = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)


class CarbonHotkey:
    """A single system-wide hotkey registered with Carbon."""

    def __init__(self, hotkey: str, callback: Callable[[], None]) -> None:
        self.keycode, self.modifiers = parse_hotkey(hotkey)
        self._callback = callback
        self._id = next(_ids)
        self._carbon = None
        self._handler_ref = ctypes.c_void_p()
        self._hotkey_ref = ctypes.c_void_p()
        self._handler = None

    def start(self) -> None:
        if sys.platform != "darwin":
            raise HotkeyError("Carbon hotkeys are macOS-only")
        if self._hotkey_ref.value:
            return
        carbon = ctypes.CDLL("/System/Library/Frameworks/Carbon.framework/Carbon")
        carbon.GetApplicationEventTarget.restype = ctypes.c_void_p
        carbon.InstallEventHandler.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.POINTER(_EventTypeSpec),
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        carbon.InstallEventHandler.restype = ctypes.c_int32
        carbon.GetEventParameter.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_void_p,
            ctypes.c_void_p,
        ]
        carbon.GetEventParameter.restype = ctypes.c_int32
        carbon.RegisterEventHotKey.argtypes = [
            ctypes.c_uint32,
            ctypes.c_uint32,
            _EventHotKeyID,
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        carbon.RegisterEventHotKey.restype = ctypes.c_int32
        carbon.UnregisterEventHotKey.argtypes = [ctypes.c_void_p]
        carbon.UnregisterEventHotKey.restype = ctypes.c_int32
        carbon.RemoveEventHandler.argtypes = [ctypes.c_void_p]
        carbon.RemoveEventHandler.restype = ctypes.c_int32

        target = carbon.GetApplicationEventTarget()
        if not target:
            raise HotkeyError("No application event target (is a GUI event loop running?)")

        self._handler = _CALLBACK(self._handle)
        spec = _EventTypeSpec(FOURCC_KEYBOARD, EVENT_HOTKEY_PRESSED)
        status = carbon.InstallEventHandler(
            target,
            ctypes.cast(self._handler, ctypes.c_void_p),
            1,
            ctypes.byref(spec),
            None,
            ctypes.byref(self._handler_ref),
        )
        if status != 0:
            self._handler = None
            raise HotkeyError(f"InstallEventHandler failed (OSStatus {status})")

        hotkey_id = _EventHotKeyID(HOTKEY_SIGNATURE, self._id)
        status = carbon.RegisterEventHotKey(
            self.keycode,
            self.modifiers,
            hotkey_id,
            target,
            0,
            ctypes.byref(self._hotkey_ref),
        )
        if status != 0:
            carbon.RemoveEventHandler(self._handler_ref)
            self._handler_ref = ctypes.c_void_p()
            self._handler = None
            raise HotkeyError(f"RegisterEventHotKey failed (OSStatus {status})")
        self._carbon = carbon

    def _handle(self, _call_ref, event, _user_data) -> int:
        # Every handler installed on the application target receives every
        # hotkey event, so filter on this hotkey's own ID. Returning
        # eventNotHandledErr lets another handler claim the event.
        hotkey_id = _EventHotKeyID()
        status = self._carbon.GetEventParameter(
            event,
            PARAM_DIRECT_OBJECT,
            TYPE_EVENT_HOTKEY_ID,
            None,
            ctypes.sizeof(hotkey_id),
            None,
            ctypes.byref(hotkey_id),
        )
        if status != 0 or hotkey_id.signature != HOTKEY_SIGNATURE or hotkey_id.id != self._id:
            return EVENT_NOT_HANDLED
        try:
            self._callback()
        except Exception:  # noqa: BLE001 - a Carbon callback must never throw
            pass
        return 0

    def stop(self) -> None:
        carbon = self._carbon
        if carbon is not None:
            if self._hotkey_ref.value:
                carbon.UnregisterEventHotKey(self._hotkey_ref)
                self._hotkey_ref = ctypes.c_void_p()
            if self._handler_ref.value:
                carbon.RemoveEventHandler(self._handler_ref)
                self._handler_ref = ctypes.c_void_p()
        self._handler = None
        self._carbon = None
