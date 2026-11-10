"""Filesystem locations used by the Svara desktop app.

Everything the app writes lives in one user-data directory so a profile can be
backed up, inspected or deleted as a unit:

    ~/Library/Application Support/Svara/
        settings.json   persisted preferences
        recordings/     completed recordings (never deleted automatically)
        logs/svara.log  JSON-lines runtime log (rotated at 2 MB)

``SVARA_DATA_DIR`` overrides the location (used by tests and self-test mode).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "Svara"
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def user_data_dir() -> Path:
    override = os.environ.get("SVARA_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif sys.platform.startswith("win"):
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / APP_NAME


def recordings_dir() -> Path:
    return user_data_dir() / "recordings"


def logs_dir() -> Path:
    return user_data_dir() / "logs"


def settings_path() -> Path:
    return user_data_dir() / "settings.json"


def log_path() -> Path:
    return logs_dir() / "svara.log"


def mac_paste_helper() -> Path:
    """Resolve the bundled CGEventPost helper, or an empty path when absent."""
    candidates = [
        PROJECT_ROOT / "assets" / "bin" / "mac-paste",
    ]
    bundle_dir = getattr(sys, "_MEIPASS", None)
    if bundle_dir:
        candidates.insert(0, Path(bundle_dir) / "assets" / "bin" / "mac-paste")
    if getattr(sys, "frozen", False):
        candidates.insert(0, Path(sys.executable).resolve().parent / "assets" / "bin" / "mac-paste")
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return Path()
