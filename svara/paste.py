"""Text insertion at the current cursor position on macOS.

Clipboard write + a synthetic Cmd+V. The bundled ``mac-paste`` helper does the
keystroke through CoreGraphics, which works in every app; AppleScript via
System Events is the fallback. macOS Secure Input (password fields) is detected
first so dictated text is never typed into one.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

from . import paths
from .macos import accessibility_trusted, secure_input_enabled

PASTED = "pasted"
SECURE_INPUT = "secure-input"
CLIPBOARD_ONLY = "clipboard-only"
NO_ACCESSIBILITY = "no-accessibility"
FAILED = "failed"


def copy_to_clipboard(text: str) -> None:
    if sys.platform == "darwin":
        subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True, timeout=5)
        return
    from PySide6.QtGui import QGuiApplication  # local import: optional dependency

    clipboard = QGuiApplication.clipboard()
    clipboard.setText(text)


def _run_helper(helper: Path, timeout: float) -> bool:
    try:
        completed = subprocess.run([str(helper)], capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0


def _quartz_paste() -> bool:
    """Press Cmd+V from inside this process.

    A separate helper binary is not covered by the app's Accessibility grant,
    so CoreGraphics drops its keystrokes even though it exits 0. Posting from
    the trusted process itself is what actually reaches the focused app.
    """
    if sys.platform != "darwin":
        return False
    try:
        from Quartz import (
            CGEventCreateKeyboardEvent,
            CGEventPost,
            CGEventSetFlags,
            kCGHIDEventTap,
            kCGEventFlagMaskCommand,
        )
    except Exception:  # noqa: BLE001 - pyobjc is optional
        return False
    try:
        for pressed in (True, False):
            event = CGEventCreateKeyboardEvent(None, 9, pressed)  # 9 = V
            CGEventSetFlags(event, kCGEventFlagMaskCommand)
            CGEventPost(kCGHIDEventTap, event)
            time.sleep(0.03)
    except Exception:  # noqa: BLE001 - fall through to the helper
        return False
    return True


def _run_applescript(timeout: float) -> bool:
    script = 'tell application "System Events" to key code 9 using command down'
    try:
        completed = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0


def paste_at_cursor(text: str, helper: Optional[Path] = None, timeout: float = 2.0) -> str:
    """Put ``text`` on the clipboard and press Cmd+V.

    Returns one of ``pasted``, ``secure-input``, ``clipboard-only`` or
    ``failed``. The clipboard always receives the text first, so even a failed
    keystroke leaves the dictation one Cmd+V away.
    """
    try:
        copy_to_clipboard(text)
    except (OSError, subprocess.SubprocessError):
        return FAILED
    if secure_input_enabled():
        return SECURE_INPUT
    if not accessibility_trusted():
        return NO_ACCESSIBILITY
    if _quartz_paste():
        return PASTED
    resolved = helper if helper is not None else paths.mac_paste_helper()
    if resolved and Path(resolved).is_file() and _run_helper(Path(resolved), timeout):
        return PASTED
    if sys.platform == "darwin" and _run_applescript(timeout):
        return PASTED
    return CLIPBOARD_ONLY
