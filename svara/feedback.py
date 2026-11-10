"""Audible and Notification Center feedback for dictation.

A short system sound confirms that the transcript is ready, and when the text
could not be pasted automatically a macOS notification carries the preview so
the user knows to press Cmd+V. Both are optional and free of extra permissions.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

READY_SOUND = "/System/Library/Sounds/Pop.aiff"
ERROR_SOUND = "/System/Library/Sounds/Basso.aiff"

_NOTIFICATION_SCRIPT = """
on run argv
    display notification (item 1 of argv) with title (item 2 of argv)
end run
"""


def preview(text: str, limit: int = 160) -> str:
    collapsed = " ".join(text.split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"


def play_chime(kind: str = "ready") -> bool:
    if sys.platform != "darwin":
        return False
    sound = ERROR_SOUND if kind == "error" else READY_SOUND
    if not Path(sound).is_file():
        return False
    try:
        subprocess.Popen(
            ["afplay", sound],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return False
    return True


def notify(title: str, message: str) -> bool:
    if sys.platform != "darwin":
        return False
    body = preview(message, 200) or "Dictation is on the clipboard."
    try:
        completed = subprocess.run(
            ["osascript", "-e", _NOTIFICATION_SCRIPT, body, title],
            capture_output=True,
            timeout=6,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0
