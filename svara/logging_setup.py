"""Application logging.

A JSON-lines log is the first place to look when the app misbehaves. Every
record is one line with ``timestamp``/``level``/``scope``/``message`` and
optional ``details``, so it can be grepped, tailed or parsed without the app
being running. The file rotates at 2 MB to ``svara.log.1``.

Logging must never become the reason the app fails: every filesystem error is
swallowed here.
"""

from __future__ import annotations

import json
import sys
import threading
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import paths

MAX_LOG_BYTES = 2 * 1024 * 1024


def _describe(error: Any) -> Any:
    if error is None:
        return None
    if isinstance(error, BaseException):
        return {
            "type": type(error).__name__,
            "message": str(error),
            "traceback": "".join(
                traceback.format_exception(type(error), error, error.__traceback__)
            )[-4000:],
        }
    return error


class AppLogger:
    def __init__(self, path: Path, max_bytes: int = MAX_LOG_BYTES) -> None:
        self._path = Path(path)
        self._max_bytes = max_bytes
        self._lock = threading.Lock()
        self._path.parent.mkdir(parents=True, exist_ok=True)

    @property
    def path(self) -> Path:
        return self._path

    def _rotate(self) -> None:
        try:
            if self._path.stat().st_size <= self._max_bytes:
                return
            rotated = self._path.with_name(self._path.name + ".1")
            if rotated.exists():
                rotated.unlink()
            self._path.replace(rotated)
        except FileNotFoundError:
            return
        except OSError:
            return

    def log(self, level: str, scope: str, message: str, details: Any = None) -> None:
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "level": level,
            "scope": scope,
            "message": message,
        }
        if details is not None:
            record["details"] = details
        line = json.dumps(record, ensure_ascii=False, default=str) + "\n"
        with self._lock:
            try:
                self._rotate()
                with self._path.open("a", encoding="utf-8") as handle:
                    handle.write(line)
            except OSError:
                return

    def info(self, scope: str, message: str, details: Any = None) -> None:
        self.log("INFO", scope, message, details)

    def warn(self, scope: str, message: str, details: Any = None) -> None:
        self.log("WARN", scope, message, details)

    def error(self, scope: str, message: str, error: Any = None) -> None:
        self.log("ERROR", scope, message, _describe(error))


_logger: AppLogger | None = None


def init_logging(path: Path | None = None, max_bytes: int = MAX_LOG_BYTES) -> AppLogger:
    global _logger
    target = Path(path) if path is not None else paths.log_path()
    try:
        _logger = AppLogger(target, max_bytes=max_bytes)
        _logger.info("logger", "Logger initialized", {"logFilePath": str(target)})
    except OSError as error:
        # Fall back to a sink that silently drops records instead of crashing.
        print(f"svara: cannot write log file {target}: {error}", file=sys.stderr)
        _logger = _NullLogger(target)
    return _logger


class _NullLogger(AppLogger):
    def __init__(self, path: Path) -> None:  # noqa: D401 - deliberate no-op sink
        self._path = Path(path)
        self._max_bytes = 0
        self._lock = threading.Lock()

    def log(self, level: str, scope: str, message: str, details: Any = None) -> None:
        return


def get_logger() -> AppLogger:
    global _logger
    if _logger is None:
        _logger = init_logging()
    return _logger


def install_excepthook(logger: AppLogger | None = None) -> None:
    log = logger or get_logger()

    def hook(exc_type, exc, tb) -> None:  # type: ignore[no-untyped-def]
        log.error("process", "Uncaught exception", exc)
        traceback.print_exception(exc_type, exc, tb, file=sys.stderr)

    sys.excepthook = hook

    if hasattr(threading, "excepthook"):
        def thread_hook(args) -> None:  # type: ignore[no-untyped-def]
            if args.exc_value is not None:
                log.error("thread", f"Unhandled exception in thread {args.thread.name}", args.exc_value)

        threading.excepthook = thread_hook
