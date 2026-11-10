"""Application entry point: ``python3 -m svara``."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

from . import __version__, paths
from .logging_setup import AppLogger, init_logging, install_excepthook
from .settings import Settings


def _build_window(settings: Settings, settings_path: Path, logger: AppLogger):
    from .ui.main_window import MainWindow

    return MainWindow(settings=settings, settings_path=settings_path, logger=logger)


def _apply_font(app) -> None:
    from PySide6.QtGui import QFont, QFontDatabase

    families = set(QFontDatabase.families())
    for name in ("SF Pro Text", "Helvetica Neue", "Helvetica", "Arial"):
        if name in families:
            app.setFont(QFont(name, 13))
            return


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="svara", description="Svara — sovereign local dictation")
    parser.add_argument("--data-dir", help="override the Svara user-data directory")
    parser.add_argument("--self-test", action="store_true", help="run headless checks and exit")
    parser.add_argument("--transcribe", metavar="AUDIO", help="transcribe an audio file, print the text, exit")
    parser.add_argument(
        "--accessibility-check",
        action="store_true",
        help="print Accessibility permission state and exit",
    )
    parser.add_argument("--version", action="version", version=f"Svara {__version__}")
    args = parser.parse_args(argv)

    if args.data_dir:
        os.environ["SVARA_DATA_DIR"] = str(Path(args.data_dir).expanduser())
    if args.self_test:
        return self_test()
    if args.transcribe:
        settings = Settings.load(paths.settings_path())
        from .transcriber import Transcriber

        transcriber = Transcriber(model_repo=settings.model_repo, cache_dir=settings.stt_cache_dir)
        print(transcriber.transcribe(Path(args.transcribe).expanduser()))
        return 0
    if args.accessibility_check:
        from .macos import accessibility_trusted, secure_input_enabled

        print("accessibility_trusted:", accessibility_trusted())
        print("secure_input:", secure_input_enabled())
        print("paste_helper:", paths.mac_paste_helper())
        return 0

    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import QApplication

    logger = init_logging()
    install_excepthook(logger)
    logger.info("app", "Svara is starting", {"version": __version__})
    from .macos import accessibility_trusted

    logger.info("app", "Accessibility state", {"trusted": accessibility_trusted(), "frozen": getattr(sys, "frozen", False)})

    from .recorder import cleanup_stale_temp_dirs

    removed = cleanup_stale_temp_dirs()
    if removed:
        logger.info("app", "Removed stale temporary recordings", {"directories": removed})

    app = QApplication([sys.argv[0]])
    app.setStyle("Fusion")
    app.setApplicationName("Svara")
    app.setApplicationDisplayName("Svara")
    _apply_font(app)
    icon = paths.PROJECT_ROOT / "assets" / "icon.png"
    if icon.is_file():
        app.setWindowIcon(QIcon(str(icon)))

    settings = Settings.load(paths.settings_path())
    from .ui.theme import apply_native_appearance, stylesheet as theme_stylesheet

    app.setStyleSheet(theme_stylesheet(settings.theme))
    apply_native_appearance(settings.theme)

    from PySide6.QtCore import QLockFile
    from PySide6.QtWidgets import QMessageBox

    paths.user_data_dir().mkdir(parents=True, exist_ok=True)
    instance_lock = QLockFile(str(paths.user_data_dir() / "svara.lock"))
    instance_lock.setStaleLockTime(30_000)
    if not instance_lock.tryLock(200):
        QMessageBox.information(None, "Svara", "Svara is already running.")
        return 0
    globals()["_instance_lock"] = instance_lock

    window = _build_window(settings, paths.settings_path(), logger)
    window.show()
    logger.info("app", "Window shown")
    return app.exec()


def self_test() -> int:
    """Headless verification used by CI and by ``--self-test``."""
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    results: list[tuple[str, bool, str]] = []

    with tempfile.TemporaryDirectory(prefix="svara-selftest-") as temporary:
        os.environ["SVARA_DATA_DIR"] = temporary
        log_path = Path(temporary) / "logs" / "svara.log"
        logger = init_logging(log_path)
        install_excepthook(logger)

        def check(name: str, action) -> None:
            try:
                action()
                results.append((name, True, ""))
            except Exception as error:  # noqa: BLE001 - reported below
                results.append((name, False, f"{type(error).__name__}: {error}"))

        def check_logging() -> None:
            logger.info("selftest", "probe")
            records = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
            assert any(record.get("scope") == "selftest" for record in records), "probe record missing"

        def check_settings() -> None:
            from .models import DEFAULT_MODEL_REPO

            settings_file = Path(temporary) / "settings.json"
            settings = Settings(model_repo=DEFAULT_MODEL_REPO, llm_model="probe")
            settings.save(settings_file)
            loaded = Settings.load(settings_file)
            assert loaded.model_repo == DEFAULT_MODEL_REPO
            assert loaded.llm_model == "probe"
            assert loaded.prompt_template.strip(), "prompt template lost"

        def check_summarizer() -> None:
            from .summarizer import build_request, build_user_prompt

            prompt = build_user_prompt("Summarize:\n{{transcript}}", "hello")
            assert prompt == "Summarize:\nhello"
            url, body, headers = build_request("http://127.0.0.1:1234/v1", "probe", prompt)
            assert url.endswith("/chat/completions")
            assert json.loads(body)["model"] == "probe"
            assert headers["Content-Type"] == "application/json"

        def check_environment() -> None:
            assert shutil.which("ffmpeg"), "ffmpeg is not on PATH"
            assert paths.mac_paste_helper().is_file(), "mac-paste helper is missing"

        def check_transcriber() -> None:
            import faster_whisper  # noqa: F401 - import check only

        def check_window() -> None:
            from PySide6.QtWidgets import QApplication

            app = QApplication.instance() or QApplication([sys.argv[0]])
            _apply_font(app)
            settings = Settings()
            window = _build_window(settings, Path(temporary) / "settings.json", logger)
            window.show()
            app.processEvents()
            window.close()
            app.processEvents()
            metrics = window.status_label.fontMetrics()
            assert metrics.height() > 0

        check("logging", check_logging)
        check("settings", check_settings)
        check("summarizer", check_summarizer)
        check("environment", check_environment)
        check("transcriber", check_transcriber)
        check("window", check_window)

    failures = [item for item in results if not item[1]]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if failures:
        print(f"\nSELFTEST FAILED ({len(failures)}/{len(results)})")
        return 1
    print(f"\nSELFTEST PASSED ({len(results)}/{len(results)})")
    return 0


if __name__ == "__main__":  # pragma: no cover - module entry
    try:
        raise SystemExit(main())
    except Exception:  # noqa: BLE001 - last-resort traceback
        traceback.print_exc()
        raise SystemExit(1)
