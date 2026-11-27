"""Thin macOS system integrations used by dictation and paste."""

from __future__ import annotations

import ctypes
import ctypes.util
import subprocess
import sys


def accessibility_trusted() -> bool:
    """True when this process may use Accessibility APIs (never prompts)."""
    if sys.platform != "darwin":
        return True
    try:
        services = ctypes.CDLL(ctypes.util.find_library("ApplicationServices"))
        services.AXIsProcessTrusted.restype = ctypes.c_bool
        return bool(services.AXIsProcessTrusted())
    except (OSError, AttributeError):
        return False


def open_accessibility_settings() -> None:
    if sys.platform != "darwin":
        return
    try:
        subprocess.run(
            [
                "open",
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            ],
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return


def request_accessibility() -> None:
    """Ask macOS to show its Accessibility prompt (once per process)."""
    if sys.platform != "darwin":
        return
    try:
        from ApplicationServices import AXIsProcessTrustedWithOptions, kAXTrustedCheckOptionPrompt

        AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: True})
    except Exception:  # noqa: BLE001 - a missing prompt must never break dictation
        open_accessibility_settings()


def secure_input_enabled() -> bool:
    """True while macOS Secure Input is active (e.g. a password field)."""
    if sys.platform != "darwin":
        return False
    try:
        completed = subprocess.run(
            ["ioreg", "-l", "-w", "0"],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return "SecureInput" in completed.stdout


def display_hotkey(hotkey: str) -> str:
    table = {
        "<alt>": "⌥",
        "<ctrl>": "⌃",
        "<cmd>": "⌘",
        "<shift>": "⇧",
        "<space>": "Space",
    }
    text = hotkey
    for token, symbol in table.items():
        text = text.replace(token, symbol)
    return "+".join(part.upper() if len(part) == 1 and part.isalpha() else part for part in text.split("+"))
