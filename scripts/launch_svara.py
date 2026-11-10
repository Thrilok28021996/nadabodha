"""PyInstaller entry point for the Svara .app bundle."""

from __future__ import annotations

import multiprocessing
import sys
from pathlib import Path

if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if __name__ == "__main__":
    multiprocessing.freeze_support()

from svara.app import main

raise SystemExit(main())
