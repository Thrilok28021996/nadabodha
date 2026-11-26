"""Svara's main window: record, import, dictate, transcribe, summarize."""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

from PySide6.QtCore import QEventLoop, Qt, QThread, QTimer, Signal
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QProgressDialog,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from .. import feedback, paths
from ..dictation import DictationController
from ..hotkey import CarbonHotkey
from ..logging_setup import AppLogger
from ..macos import accessibility_trusted, display_hotkey, open_accessibility_settings, request_accessibility
from ..output import OutputError, ensure_output_root, save_recording, save_summary, save_transcript
from ..paste import CLIPBOARD_ONLY, FAILED, NO_ACCESSIBILITY, PASTED, SECURE_INPUT, copy_to_clipboard, paste_at_cursor
from ..recorder import Recorder, RecorderError, persist_recording
from ..settings import Settings
from ..summarizer import Summarizer
from ..system_audio import SystemAudioError, SystemAudioRecorder, mix_wavs
from ..transcriber import Segment, Transcriber, TranscriptionResult
from ..exports import build_srt, build_vtt
from .library_dialog import LibraryDialog
from .settings_dialog import SettingsDialog
from .theme import stylesheet as theme_stylesheet
from .banner import ERROR as BANNER_ERROR
from .banner import SUCCESS as BANNER_SUCCESS
from .banner import StatusBanner
from .toast import PasteToast
from ..watch import WatchFolder

AUDIO_FILTER = "Audio (*.wav *.mp3 *.m4a *.ogg *.flac *.aac *.aiff *.wma)"
AUDIO_SUFFIXES = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac", ".aiff", ".wma"}


def transcribe_options(origin: str, settings: Settings) -> dict:
    """Per-origin transcription flags.

    Dictation is a few seconds long and only ever pasted as plain text, so two
    fixed per-call costs can go: Whisper's language-detection pass (skipped by
    pinning the language) and timestamp-token decoding. Minutes-long recordings
    and imports keep timestamps because SRT/VTT export depends on them, and they
    keep auto-detection because they may not be English.
    """
    if origin != "dictation":
        return {}
    options: dict = {"without_timestamps": True}
    language = (settings.dictation_language or "").strip()
    if language and language.lower() != "auto":
        options["language"] = language
    return options


class _TranscribeWorker(QThread):
    ready = Signal(object)
    failed = Signal(str)

    def __init__(
        self,
        transcriber: Transcriber,
        audio: Path,
        options: dict | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._transcriber = transcriber
        self._audio = audio
        self._options = dict(options or {})

    def run(self) -> None:  # noqa: D401 - Qt override
        try:
            self.ready.emit(self._transcriber.transcribe_result(self._audio, **self._options))
        except Exception as error:  # noqa: BLE001 - surfaced in the UI
            self.failed.emit(str(error))


class _PreloadWorker(QThread):
    """Load the speech model off the UI thread so the first take is fast."""

    done = Signal(str)

    def __init__(self, transcriber: Transcriber, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._transcriber = transcriber

    def run(self) -> None:  # noqa: D401 - Qt override
        try:
            self._transcriber.preload()
        except Exception as error:  # noqa: BLE001 - preloading is an optimisation
            self.done.emit(str(error))
            return
        self.done.emit("")


class _SummaryWorker(QThread):
    ready = Signal(str)
    failed = Signal(str)

    def __init__(self, summarizer: Summarizer, transcript: str, template: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._summarizer = summarizer
        self._transcript = transcript
        self._template = template

    def run(self) -> None:  # noqa: D401 - Qt override
        try:
            self.ready.emit(self._summarizer.summarize(self._transcript, self._template))
        except Exception as error:  # noqa: BLE001 - surfaced in the UI
            self.failed.emit(str(error))


class _ModelDownloadWorker(QThread):
    total = Signal(int)
    ok = Signal()
    failed = Signal(str)

    def __init__(self, transcriber: Transcriber, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._transcriber = transcriber

    def run(self) -> None:  # noqa: D401 - Qt override
        try:
            size = self._transcriber.expected_bytes()
            if size:
                self.total.emit(size)
            self._transcriber.download()
            self.ok.emit()
        except Exception as error:  # noqa: BLE001 - surfaced in the UI
            self.failed.emit(str(error))


class MainWindow(QMainWindow):
    def __init__(
        self,
        settings: Settings,
        settings_path: Path,
        logger: AppLogger,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.settings = settings
        self.settings_path = Path(settings_path)
        self.log = logger
        self.recorder = Recorder(input_device=settings.input_device)
        self.system_recorder = SystemAudioRecorder()
        self._transcriber_instance: Transcriber | None = None
        self._transcriber_key: tuple[str, str, str] | None = None
        self._preload_worker: _PreloadWorker | None = None
        self._transcribe_worker: _TranscribeWorker | None = None
        self._summary_worker: _SummaryWorker | None = None
        self._model_worker: _ModelDownloadWorker | None = None
        self._mode: str | None = None  # 'record' while a manual recording is open
        self._busy = False
        self._recording_hotkey: CarbonHotkey | None = None
        self._toast: PasteToast | None = None
        self._banner: StatusBanner | None = None
        self._accessibility_prompted = False
        self._started_at = 0.0
        self._saved_transcript = ""
        self._saved_transcript_path: Path | None = None
        self._watch_queue: list[Path] = []
        self._segments: list[Segment] = []
        self._record_sources: list[str] = []

        self._timer = QTimer(self)
        self._timer.setInterval(500)
        self._timer.timeout.connect(self._refresh_elapsed)

        self.setWindowTitle("Svara")
        self.resize(1120, 780)
        self.setMinimumSize(880, 620)
        self.setAcceptDrops(True)
        self.setStyleSheet(theme_stylesheet(settings.theme))
        self._build_ui()
        self._build_menu()

        self.dictation = DictationController(self.recorder, settings.dictation_hotkey, self)
        self.dictation.set_guard(lambda: not self._busy and self._mode is None)
        self.dictation.started.connect(self._on_dictation_started)
        self.dictation.finished.connect(self._on_dictation_finished)
        self.dictation.failed.connect(self._on_dictation_failed)
        self.dictation.listening_changed.connect(self._on_dictation_listening_changed)

        self.watch = WatchFolder(self)
        self.watch.file_ready.connect(self._on_watch_file)

        self._apply_settings()
        self._prepare_output_folder()
        self._set_idle_status("Ready")

        self._permission_timer = QTimer(self)
        self._permission_timer.setInterval(2000)
        self._permission_timer.timeout.connect(self._refresh_permissions)
        self._permission_timer.start()
        self._permission_untrusted = False
        self._refresh_permissions()

        self.log.info("ui", "Main window ready")

    # ------------------------------------------------------------------ UI

    def _build_ui(self) -> None:
        central = QWidget(self)
        central.setObjectName("root")
        layout = QVBoxLayout(central)
        layout.setContentsMargins(22, 20, 22, 16)
        layout.setSpacing(14)

        header = QHBoxLayout()
        header.setSpacing(8)
        titles = QVBoxLayout()
        titles.setSpacing(1)
        title = QLabel("Svara")
        title.setObjectName("title")
        subtitle = QLabel("Private local dictation and transcription")
        subtitle.setObjectName("subtitle")
        titles.addWidget(title)
        titles.addWidget(subtitle)
        header.addLayout(titles)
        header.addStretch(1)
        self.logs_button = QPushButton("Logs")
        self.logs_button.setObjectName("subtle")
        self.logs_button.clicked.connect(self._open_logs)
        self.library_button = QPushButton("Library")
        self.library_button.setObjectName("ghost")
        self.library_button.clicked.connect(self._open_library)
        self.settings_button = QPushButton("Settings")
        self.settings_button.setObjectName("ghost")
        self.settings_button.clicked.connect(self._open_settings)
        header.addWidget(self.logs_button)
        header.addWidget(self.library_button)
        header.addWidget(self.settings_button)
        layout.addLayout(header)

        hero = QFrame()
        hero.setObjectName("card")
        hero_layout = QVBoxLayout(hero)
        hero_layout.setContentsMargins(18, 14, 18, 14)
        hero_layout.setSpacing(8)
        status_row = QHBoxLayout()
        status_row.setSpacing(10)
        self.status_dot = QLabel()
        self.status_dot.setObjectName("statusDot")
        self.status_dot.setProperty("state", "idle")
        self.status_dot.setFixedSize(10, 10)
        self.status_label = QLabel("Ready")
        self.status_label.setObjectName("status")
        self.status_label.setWordWrap(True)
        self.elapsed_label = QLabel("00:00")
        self.elapsed_label.setObjectName("elapsed")
        status_row.addWidget(self.status_dot)
        status_row.addWidget(self.status_label, 1)
        status_row.addWidget(self.elapsed_label)
        hero_layout.addLayout(status_row)
        self.hint_label = QLabel("")
        self.hint_label.setObjectName("hint")
        self.hint_label.setWordWrap(True)
        hero_layout.addWidget(self.hint_label)

        self.permission_row = QWidget()
        permission_layout = QHBoxLayout(self.permission_row)
        permission_layout.setContentsMargins(0, 0, 0, 0)
        permission_layout.setSpacing(10)
        self.permission_label = QLabel("Paste needs Accessibility permission for Svara.")
        self.permission_label.setObjectName("hint")
        self.permission_button = QPushButton("Enable…")
        self.permission_button.setObjectName("ghost")
        self.permission_button.clicked.connect(self._enable_accessibility)
        permission_layout.addWidget(self.permission_label, 1)
        permission_layout.addWidget(self.permission_button)
        self.permission_row.setVisible(False)
        hero_layout.addWidget(self.permission_row)

        layout.addWidget(hero)

        actions = QHBoxLayout()
        actions.setSpacing(8)
        self.record_button = QPushButton("Start recording")
        self.record_button.setObjectName("primary")
        self.record_button.setMinimumWidth(160)
        self.record_button.clicked.connect(self._on_record_clicked)
        self.import_button = QPushButton("Import audio")
        self.import_button.setObjectName("ghost")
        self.import_button.clicked.connect(self._on_import)
        self.dictate_button = QPushButton("Dictate")
        self.dictate_button.setObjectName("ghost")
        self.dictate_button.clicked.connect(self.dictation_toggle)
        self.summarize_button = QPushButton("Summarize")
        self.summarize_button.setObjectName("ghost")
        self.summarize_button.clicked.connect(self._on_summarize)
        self.copy_button = QPushButton("Copy")
        self.copy_button.setObjectName("subtle")
        self.copy_button.clicked.connect(self._on_copy)
        self.save_button = QPushButton("Save")
        self.save_button.setObjectName("subtle")
        self.save_button.clicked.connect(self._on_save)
        actions.addWidget(self.record_button)
        actions.addWidget(self.import_button)
        actions.addWidget(self.dictate_button)
        actions.addStretch(1)
        actions.addWidget(self.summarize_button)
        actions.addWidget(self.copy_button)
        actions.addWidget(self.save_button)
        layout.addLayout(actions)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.setHandleWidth(12)
        splitter.setChildrenCollapsible(False)

        transcript_panel = QFrame()
        transcript_panel.setObjectName("card")
        transcript_layout = QVBoxLayout(transcript_panel)
        transcript_layout.setContentsMargins(16, 14, 16, 14)
        transcript_layout.setSpacing(8)
        transcript_head = QHBoxLayout()
        transcript_title = QLabel("TRANSCRIPT")
        transcript_title.setObjectName("sectionTitle")
        self.transcript_meta = QLabel("0 words")
        self.transcript_meta.setObjectName("meta")
        transcript_head.addWidget(transcript_title)
        transcript_head.addStretch(1)
        transcript_head.addWidget(self.transcript_meta)
        self.transcript = QPlainTextEdit()
        self.transcript.setObjectName("transcript")
        self.transcript.setPlaceholderText("Your transcript will appear here…")
        self.transcript.textChanged.connect(self._update_word_count)
        transcript_layout.addLayout(transcript_head)
        transcript_layout.addWidget(self.transcript, 1)

        summary_panel = QFrame()
        summary_panel.setObjectName("card")
        summary_layout = QVBoxLayout(summary_panel)
        summary_layout.setContentsMargins(16, 14, 16, 14)
        summary_layout.setSpacing(8)
        summary_head = QHBoxLayout()
        summary_title = QLabel("SUMMARY")
        summary_title.setObjectName("sectionTitle")
        summary_hint = QLabel("Markdown")
        summary_hint.setObjectName("meta")
        summary_head.addWidget(summary_title)
        summary_head.addStretch(1)
        summary_head.addWidget(summary_hint)
        self.summary = QPlainTextEdit()
        self.summary.setObjectName("summary")
        self.summary.setReadOnly(True)
        self.summary.setPlaceholderText("A Markdown summary will appear here…")
        summary_layout.addLayout(summary_head)
        summary_layout.addWidget(self.summary, 1)

        splitter.addWidget(transcript_panel)
        splitter.addWidget(summary_panel)
        splitter.setSizes([600, 420])
        layout.addWidget(splitter, 1)

        self.setCentralWidget(central)
        self.statusBar().showMessage(str(paths.user_data_dir()))

    def _build_menu(self) -> None:
        bar = self.menuBar()
        file_menu = bar.addMenu("File")
        settings_action = QAction("Settings…", self)
        settings_action.setShortcut(QKeySequence("Ctrl+,"))
        settings_action.triggered.connect(self._open_settings)
        file_menu.addAction(settings_action)
        library_action = QAction("Library…", self)
        library_action.setShortcut(QKeySequence("Ctrl+L"))
        library_action.triggered.connect(self._open_library)
        file_menu.addAction(library_action)
        file_menu.addSeparator()
        import_action = QAction("Import Audio…", self)
        import_action.setShortcut(QKeySequence("Ctrl+O"))
        import_action.triggered.connect(self._on_import)
        file_menu.addAction(import_action)
        record_action = QAction("Start/Stop Recording", self)
        record_action.setShortcut(QKeySequence("Ctrl+R"))
        record_action.triggered.connect(self._on_record_clicked)
        file_menu.addAction(record_action)
        file_menu.addSeparator()
        save_action = QAction("Save Transcript…", self)
        save_action.setShortcut(QKeySequence("Ctrl+S"))
        save_action.triggered.connect(self._on_save)
        file_menu.addAction(save_action)
        copy_action = QAction("Copy Transcript", self)
        copy_action.setShortcut(QKeySequence("Ctrl+Shift+C"))
        copy_action.triggered.connect(self._on_copy)
        file_menu.addAction(copy_action)
        summarize_action = QAction("Summarize", self)
        summarize_action.setShortcut(QKeySequence("Ctrl+Return"))
        summarize_action.triggered.connect(self._on_summarize)
        file_menu.addAction(summarize_action)
        file_menu.addSeparator()
        export_srt = QAction("Export SRT…", self)
        export_srt.triggered.connect(lambda: self._export_timed("srt"))
        file_menu.addAction(export_srt)
        export_vtt = QAction("Export VTT…", self)
        export_vtt.triggered.connect(lambda: self._export_timed("vtt"))
        file_menu.addAction(export_vtt)
        self.export_srt_action = export_srt
        self.export_vtt_action = export_vtt
        file_menu.addSeparator()
        quit_action = QAction("Quit Svara", self)
        quit_action.setShortcut(QKeySequence("Ctrl+Q"))
        quit_action.triggered.connect(self.close)
        file_menu.addAction(quit_action)

        help_menu = bar.addMenu("Help")
        logs_action = QAction("Open Log Folder", self)
        logs_action.triggered.connect(self._open_logs)
        help_menu.addAction(logs_action)

    # --------------------------------------------------------- settings/app

    def _apply_settings(self) -> None:
        self.recorder.set_input_device(self.settings.input_device)
        self.watch.set_folder(self.settings.watch_folder)
        self.dictation.apply(self.settings.dictation_hotkey, self.settings.dictation_enabled)
        self._apply_recording_hotkey()
        self._update_hint()
        self._update_buttons()

    def _apply_recording_hotkey(self) -> None:
        if self._recording_hotkey is not None:
            self._recording_hotkey.stop()
            self._recording_hotkey = None
        hotkey = (self.settings.recording_hotkey or "").strip()
        if not hotkey:
            return
        try:
            handle = CarbonHotkey(hotkey, self._on_recording_hotkey)
            handle.start()
        except Exception as error:  # noqa: BLE001 - reported in the log
            self.log.warn("hotkey", f"Recording hotkey unavailable: {error}", {"hotkey": hotkey})
            return
        self._recording_hotkey = handle
        self.log.info("hotkey", "Recording hotkey registered", {"hotkey": hotkey})

    def _on_recording_hotkey(self) -> None:
        if self.dictation.dictating:
            self.log.info("hotkey", "Recording hotkey ignored while dictating")
            return
        if self._busy:
            self.log.info("hotkey", "Recording hotkey ignored while busy")
            return
        if self._mode == "record":
            self._stop_recording()
        else:
            self._start_recording()

    def _update_hint(self) -> None:
        lines: list[str] = []
        if self.settings.recording_hotkey:
            recording = display_hotkey(self.settings.recording_hotkey)
            lines.append(f"Press {recording} to start or stop recording.")
        if not self.settings.dictation_enabled:
            lines.append("Global dictation is disabled in Settings.")
        else:
            hotkey = display_hotkey(self.settings.dictation_hotkey)
            suffix = "the text is pasted at the cursor." if self.settings.dictation_paste_enabled else ""
            lines.append(f"Press {hotkey} anywhere to dictate; press it again to finish. {suffix}".rstrip())
        self.hint_label.setText("\n".join(lines))

    def _open_settings(self) -> None:
        dialog = SettingsDialog(self.settings, self)
        if dialog.exec() == SettingsDialog.DialogCode.Accepted:
            self.settings = dialog.result_settings()
            try:
                self.settings.save(self.settings_path)
            except OSError as error:
                self.log.error("settings", "Could not save settings", error)
                QMessageBox.critical(self, "Settings", f"Could not save settings: {error}")
                return
            self.log.info("settings", "Settings saved", {"model": self.settings.model_repo})
            self._apply_settings()
            self._prepare_output_folder()
            sheet = theme_stylesheet(self.settings.theme)
            self.setStyleSheet(sheet)
            application = QApplication.instance()
            if application is not None:
                application.setStyleSheet(sheet)
            from .theme import apply_native_appearance

            apply_native_appearance(self.settings.theme)

    def _open_library(self) -> None:
        dialog = LibraryDialog(self._output_root(), self)
        dialog.open_transcript.connect(self._load_transcript_file)
        dialog.transcribe_requested.connect(lambda path: self._start_import(Path(path)))
        dialog.summarize_requested.connect(self._summarize_transcript_file)
        dialog.exec()

    def _load_transcript_file(self, path: str) -> None:
        target = Path(path)
        try:
            text = target.read_text(encoding="utf-8")
        except OSError as error:
            self.log.error("library", "Could not read transcript", error)
            QMessageBox.warning(self, "Library", f"Could not read {target.name}: {error}")
            return
        self.transcript.setPlainText(text)
        self.summary.clear()
        self._segments = []
        self._update_buttons()
        self._saved_transcript = text
        self._saved_transcript_path = target
        self._set_idle_status(f"Loaded {target.name}", kind="success")

    def _summarize_transcript_file(self, path: str) -> None:
        if self._busy:
            return
        self._load_transcript_file(path)
        if self.transcript.toPlainText().strip():
            self._start_summary(auto=False)

    def _enable_accessibility(self) -> None:
        request_accessibility()
        open_accessibility_settings()
        self._set_idle_status("Enable Svara in the Accessibility list; this banner disappears when it is on.")

    def _refresh_permissions(self) -> None:
        row = getattr(self, "permission_row", None)
        if row is None:
            return
        trusted = accessibility_trusted()
        wanted = self.settings.dictation_enabled and self.settings.dictation_paste_enabled
        row.setVisible(bool(wanted and not trusted))
        if trusted and self._permission_untrusted:
            self.log.info("permissions", "Accessibility granted")
            self._set_idle_status("Accessibility granted — dictation now pastes at the cursor.", kind="success")
        self._permission_untrusted = not trusted

    def _open_logs(self) -> None:
        log_path = self.log.path
        try:
            if sys.platform == "darwin":
                subprocess.run(["open", "-R", str(log_path)], check=False, timeout=5)
            elif sys.platform.startswith("win"):
                subprocess.run(["explorer", "/select,", str(log_path)], check=False, timeout=5)
            else:
                subprocess.run(["xdg-open", str(log_path.parent)], check=False, timeout=5)
        except (OSError, subprocess.SubprocessError) as error:
            self.log.error("ui", "Could not open the log folder", error)

    # ------------------------------------------------------------- recording

    def _on_record_clicked(self) -> None:
        if self._mode == "record":
            self._stop_recording()
        else:
            self._start_recording()

    def _start_recording(self) -> None:
        if (
            self._busy
            or self._mode
            or self.dictation.dictating
            or self.recorder.is_recording
            or self.system_recorder.recording
        ):
            return
        source = self.settings.audio_source if self.settings.audio_source in {"microphone", "system", "both"} else "microphone"
        started: list[str] = []
        try:
            if source in {"microphone", "both"}:
                self.recorder.start()
                started.append("microphone")
            if source in {"system", "both"}:
                self.system_recorder.start()
                started.append("system")
        except (RecorderError, SystemAudioError) as error:
            self.log.error("recorder", "Could not start recording", error)
            if "microphone" in started:
                self.recorder.cancel()
            if "system" in started:
                try:
                    self.system_recorder.stop()
                except SystemAudioError:
                    pass
                self.system_recorder.cleanup()
            self._set_idle_status(str(error), kind="error")
            QMessageBox.warning(self, "Recording", str(error))
            return
        self._record_sources = started
        self._mode = "record"
        self._started_at = time.monotonic()
        self._timer.start()
        self.record_button.setText("Stop recording")
        self.record_button.setObjectName("danger")
        self._restyle(self.record_button)
        detail = {"source": source}
        self._set_idle_status("Recording…", kind="recording")
        self._update_buttons()
        self.log.info("recorder", "Recording started", detail)

    def _stop_recording(self) -> None:
        self._mode = None
        self._timer.stop()
        self._reset_record_button()
        mic_path = None
        system_path = None
        problems: list[str] = []
        if "microphone" in getattr(self, "_record_sources", []):
            try:
                mic_path = self.recorder.stop()
            except RecorderError as error:
                problems.append(str(error))
        if "system" in getattr(self, "_record_sources", []):
            try:
                system_path = self.system_recorder.stop()
            except SystemAudioError as error:
                problems.append(str(error))
        self._record_sources = []
        if not mic_path and not system_path:
            message = problems[0] if problems else "The recording produced no audio."
            self.log.error("recorder", "Recording failed", message)
            self._set_idle_status(message, kind="error")
            QMessageBox.warning(self, "Recording", message)
            return
        if problems:
            self.log.warn("recorder", "Part of the recording failed", {"problems": problems})
        try:
            if mic_path and system_path:
                recorded = mix_wavs([mic_path, system_path], mic_path.parent / "combined.wav")
            else:
                recorded = mic_path or system_path
            assert recorded is not None
        except (SystemAudioError, OSError, EOFError) as error:
            self.log.error("recorder", "Could not combine microphone and system audio", error)
            self._set_idle_status(f"Could not combine audio: {error}", kind="error")
            QMessageBox.warning(self, "Recording", f"Could not combine audio: {error}")
            return
        self._handle_completed_recording(recorded, origin="transcription")

    def _output_root(self) -> Path:
        configured = (self.settings.output_dir or "").strip()
        return Path(configured).expanduser() if configured else paths.user_data_dir() / "output"

    def _prepare_output_folder(self) -> None:
        try:
            root = ensure_output_root(self._output_root())
        except OutputError as error:
            self.log.warn("output", str(error))
            self._set_idle_status(str(error))
            return
        self.log.info("output", "Output folder ready", {"path": str(root)})

    def _handle_completed_recording(self, recorded: Path, origin: str) -> None:
        try:
            saved = save_recording(recorded, self._output_root())
            self.log.info("output", "Recording saved", {"path": str(saved), "origin": origin})
            self._set_idle_status(f"Recording saved to {saved}")
        except (OutputError, OSError) as error:
            self.log.warn("output", f"Output folder unavailable: {error}")
            try:
                saved = persist_recording(recorded, paths.recordings_dir())
            except (RecorderError, OSError) as fallback_error:
                self.log.error("recorder", f"Recording could not be saved: {recorded}", fallback_error)
                message = f"Recording could not be saved: {fallback_error}"
                self._set_idle_status(message)
                QMessageBox.warning(self, "Recording", message)
                return
            self.log.info("recorder", "Recording saved to app storage", {"path": str(saved)})
            self._set_idle_status(f"Output folder unavailable — saved to {saved}")
        self.recorder.cleanup_after_persist(recorded)
        self.system_recorder.cleanup()
        self._transcribe(saved, origin=origin)

    def _reset_record_button(self) -> None:
        self.record_button.setText("Start recording")
        self.record_button.setObjectName("primary")
        self._restyle(self.record_button)
        self.elapsed_label.setText("00:00")

    @staticmethod
    def _restyle(widget: QWidget) -> None:
        widget.style().unpolish(widget)
        widget.style().polish(widget)

    def _refresh_elapsed(self) -> None:
        if self._started_at is None:
            return
        elapsed = int(time.monotonic() - self._started_at)
        self.elapsed_label.setText(f"{elapsed // 60:02d}:{elapsed % 60:02d}")
        limit = self.settings.max_recording_minutes * 60
        if self._mode == "record" and limit and elapsed >= limit:
            self.log.info("recorder", "Maximum recording length reached", {"minutes": self.settings.max_recording_minutes})
            self._stop_recording()

    # ------------------------------------------------------------ dictation

    def dictation_toggle(self) -> None:
        if self._busy or self._mode:
            return
        self.dictation.toggle()

    def _on_dictation_started(self) -> None:
        self._started_at = time.monotonic()
        self._timer.start()
        self.dictate_button.setText("Stop dictation")
        self.log.info("dictation", "Dictation started")
        self._set_idle_status("Dictating…", kind="recording")
        self._update_buttons()

    def _on_dictation_finished(self, recorded: str) -> None:
        self.log.info("dictation", "Dictation finished", {"recording": recorded})
        self.dictate_button.setText("Dictate")
        self._timer.stop()
        self.elapsed_label.setText("00:00")
        self._update_buttons()
        self._banner_message("Transcribing…")
        self._handle_completed_recording(Path(recorded), origin="dictation")

    def _on_dictation_failed(self, message: str) -> None:
        self.dictate_button.setText("Dictate")
        self._timer.stop()
        self.elapsed_label.setText("00:00")
        self.log.error("dictation", message)
        self._set_idle_status(message, kind="error")
        self._update_buttons()

    def _on_dictation_listening_changed(self, listening: bool, message: str) -> None:
        if listening:
            self.log.info("dictation", "Global hotkey registered", {"hotkey": self.settings.dictation_hotkey})
            return
        if message:
            self.log.warn("dictation", message)
            self.hint_label.setText(f"{message} Use the Dictate button instead.")

    def _insert_dictation(self, text: str) -> None:
        text = text.strip()
        if not text:
            self._banner_message("No speech detected", BANNER_ERROR, 4000)
            self._set_idle_status(self._empty_dictation_message(), kind="error")
            return
        existing = self.transcript.toPlainText().strip()
        self.transcript.setPlainText(f"{existing}\n{text}" if existing else text)
        self._update_buttons()
        self._autosave_transcript()
        if not self.settings.dictation_paste_enabled:
            self._dictation_feedback(text, copied=False)
            self._banner_message("Added to the transcript", BANNER_SUCCESS, 2000)
            self._set_idle_status("Dictated text added to the transcript.")
            return
        if self.isActiveWindow():
            self.log.info("dictation", "Svara is focused; appended in-app", {"chars": len(text)})
            try:
                copy_to_clipboard(text)
                self._dictation_feedback(text, copied=True)
                self._banner_message("Added and copied — press ⌘V", BANNER_SUCCESS, 2500)
                self._set_idle_status("Dictated text added to the transcript and copied to the clipboard.")
            except (OSError, subprocess.SubprocessError) as error:
                self.log.warn("dictation", "Could not copy dictated text", str(error))
                self._banner_message("Added to the transcript", BANNER_SUCCESS, 2000)
                self._set_idle_status("Dictated text added to the transcript.")
            return
        result = paste_at_cursor(text)
        self.log.info("dictation", "Paste result", {"result": result, "chars": len(text)})
        if result == PASTED:
            self._dictation_feedback(text, copied=False)
            self._banner_message("Pasted", BANNER_SUCCESS, 1400)
            self._set_idle_status("Dictated and pasted at the cursor.", kind="success")
            return
        if result == SECURE_INPUT:
            self._banner_message("Copied — secure input blocked the paste", BANNER_SUCCESS, 3200)
            self._set_idle_status("Secure input is active — dictated text was copied to the clipboard.")
        elif result == NO_ACCESSIBILITY:
            self._banner_message("Copied — grant Accessibility to paste automatically", BANNER_SUCCESS, 4000)
            self._set_idle_status(
                "Dictated text was copied to the clipboard. Grant Accessibility to Svara to paste automatically."
            )
        elif result == CLIPBOARD_ONLY:
            self._banner_message("Copied — press ⌘V", BANNER_SUCCESS, 3200)
            self._set_idle_status("Dictated text was copied to the clipboard; paste it with Cmd+V.")
        else:
            self._banner_message("Could not copy the text", BANNER_ERROR, 4000)
        self._dictation_feedback(text, copied=(result != FAILED), failed=(result == FAILED))
        self._show_paste_toast(text, result)

    def _empty_dictation_message(self) -> str:
        if self.recorder.last_rms < 0.001:
            return (
                "No audio reached Svara — check the microphone: System Settings → Privacy & Security → "
                "Microphone, and pick an input device in Sound."
            )
        return "No speech was detected in the recording."

    def _banner_message(self, text: str, kind: str = "busy", timeout_ms: int = 0) -> None:
        if self._banner is None:
            self._banner = StatusBanner()
        self._banner.show_message(text, kind, timeout_ms)

    def _dictation_feedback(self, text: str, *, copied: bool, failed: bool = False) -> None:
        if self.settings.dictation_chime:
            feedback.play_chime("error" if failed else "ready")
        if copied and not failed and self.settings.dictation_notification:
            sent = feedback.notify("Dictation ready — press ⌘V", feedback.preview(text))
            self.log.info("dictation", "Notification sent", {"ok": sent})

    def _show_paste_toast(self, text: str, result: str) -> None:
        messages = {
            NO_ACCESSIBILITY: (
                "Automatic paste is blocked because Svara lacks Accessibility permission. "
                "The text is on the clipboard — press ⌘V to paste it."
            ),
            SECURE_INPUT: (
                "Secure input is active (a password field has focus), so Svara did not paste. "
                "The text is on the clipboard — press ⌘V to paste it."
            ),
            CLIPBOARD_ONLY: (
                "Svara could not paste automatically. The text is on the clipboard — press ⌘V to paste it."
            ),
            FAILED: "The text could not be copied to the clipboard. It is in the transcript window.",
        }
        message = messages.get(result, "Dictation is ready. Press ⌘V to paste it.")
        if result == NO_ACCESSIBILITY and not self._accessibility_prompted:
            self._accessibility_prompted = True
            request_accessibility()
            self.log.info("dictation", "Requested Accessibility permission")
        if self._toast is not None:
            self._toast.close()
            self._toast = None
        self._toast = PasteToast(
            text,
            message,
            show_accessibility_button=(result == NO_ACCESSIBILITY),
            on_open_accessibility=open_accessibility_settings,
            on_copy=lambda: self._copy_dictation_again(text),
        )
        self._toast.show_near_cursor()
        self.log.info("dictation", "Paste toast shown", {"result": result})

    def _copy_dictation_again(self, text: str) -> None:
        try:
            copy_to_clipboard(text)
        except (OSError, subprocess.SubprocessError) as error:
            self.log.error("dictation", "Could not copy dictated text", error)
            if self._toast is not None:
                self._toast.set_message("Copy failed. Select the text in the transcript window instead.")
            return
        if self._toast is not None:
            self._toast.set_message("Copied to the clipboard — press ⌘V to paste.")

    # ---------------------------------------------------------- transcription

    def _transcriber(self) -> Transcriber:
        # Rebuild only when the model or its cache actually changed. Dropping
        # the instance unconditionally cost a full model reload (seconds, plus
        # 1.6 GB of re-allocation) every time Settings was saved, even for an
        # unrelated change such as the theme.
        key = (self.settings.model_repo, self.settings.stt_cache_dir, self.settings.stt_backend)
        if self._transcriber_instance is None or self._transcriber_key != key:
            self._transcriber_instance = Transcriber(
                model_repo=self.settings.model_repo,
                cache_dir=self.settings.stt_cache_dir,
                backend=self.settings.stt_backend,
            )
            self._transcriber_key = key
        return self._transcriber_instance

    def preload_speech_model(self) -> None:
        """Warm the model in the background so the first dictation is fast.

        Called by ``python3 -m svara`` after the window is shown. It is not
        started from the constructor so the headless self-test never loads a
        1.6 GB model while merely asserting that the window builds.
        """
        if not self.settings.preload_model or self._preload_worker is not None:
            return
        transcriber = self._transcriber()
        if not transcriber.is_cached():
            return
        worker = _PreloadWorker(transcriber, self)
        worker.done.connect(self._on_preload_done)
        worker.finished.connect(worker.deleteLater)
        self._preload_worker = worker
        self.log.info("transcription", "Preloading speech model")
        worker.start()

    def _on_preload_done(self, error: str) -> None:
        self._preload_worker = None
        if error:
            # Preloading is an optimisation; a failure here is not a failure of
            # transcription, which loads the model on demand instead.
            self.log.warn("transcription", "Speech model preload failed", error)
            return
        self.log.info("transcription", "Speech model preloaded")

    def _ensure_model_ready(self) -> bool:
        transcriber = self._transcriber()
        if transcriber.is_cached():
            return True
        answer = QMessageBox.question(
            self,
            "Speech model",
            (
                f"The speech model ({self.settings.model_repo}) is not downloaded yet.\n\n"
                "Download it now? It is about 1.6 GB and only needed once."
            ),
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.Yes,
        )
        if answer != QMessageBox.StandardButton.Yes:
            self._set_idle_status("Transcription cancelled: the speech model is not downloaded.")
            return False
        return self._download_model(transcriber)

    def _download_model(self, transcriber: Transcriber) -> bool:
        dialog = QProgressDialog("Preparing download…", None, 0, 100, self)
        dialog.setWindowTitle("Downloading speech model")
        dialog.setWindowModality(Qt.WindowModality.WindowModal)
        dialog.setMinimumDuration(0)
        dialog.setAutoClose(False)
        dialog.setAutoReset(False)
        dialog.setCancelButton(None)

        expected = {"bytes": 0}
        success = {"value": False}
        worker = _ModelDownloadWorker(transcriber, self)
        self._model_worker = worker
        worker.total.connect(lambda value: expected.__setitem__("bytes", value))
        loop = QEventLoop(self)

        def finished_ok() -> None:
            success["value"] = True
            loop.quit()

        def failed(message: str) -> None:
            self.log.error("model", "Model download failed", message)
            QMessageBox.warning(self, "Speech model", message)
            loop.quit()

        worker.ok.connect(finished_ok)
        worker.failed.connect(failed)

        timer = QTimer(self)

        def tick() -> None:
            done = transcriber.cached_bytes()
            total = expected["bytes"] or 1_620_000_000
            percent = min(99, int(done * 100 / total)) if total else 0
            dialog.setValue(percent)
            dialog.setLabelText(
                f"Downloading speech model… {done / 1e9:.2f} GB of {total / 1e9:.2f} GB"
            )

        timer.timeout.connect(tick)
        timer.start(500)
        dialog.show()
        worker.start()
        loop.exec()
        timer.stop()
        worker.wait(2000)
        dialog.close()
        self._model_worker = None
        if success["value"]:
            self.log.info("model", "Model downloaded", {"repo": self.settings.model_repo})
            self._set_idle_status("Speech model downloaded.")
        return success["value"]

    def _transcribe(self, audio: Path, origin: str) -> None:
        if not self._ensure_model_ready():
            return
        self._set_busy(True)
        self._set_idle_status(f"Transcribing {Path(audio).name}…", kind="busy")
        worker = _TranscribeWorker(self._transcriber(), Path(audio), transcribe_options(origin, self.settings), self)
        worker.ready.connect(lambda result: self._on_transcribed(result, origin))
        worker.failed.connect(lambda message: self._on_transcribe_failed(message, origin))
        worker.finished.connect(worker.deleteLater)
        self._transcribe_worker = worker
        worker.start()

    def _on_transcribed(self, result: TranscriptionResult, origin: str) -> None:
        text = result.text
        self._set_busy(False)
        self._transcribe_worker = None
        self.log.info("transcription", "Transcription completed", {"origin": origin, "chars": len(text)})
        if origin == "dictation":
            self._insert_dictation(text)
            return
        self._segments = list(result.segments)
        self.transcript.setPlainText(text)
        self._update_buttons()
        if not text.strip():
            self._set_idle_status(self._empty_dictation_message())
            return
        status = "Transcript ready."
        try:
            saved = save_transcript(self._output_root(), text)
            self._saved_transcript = text
            self._saved_transcript_path = saved
            self.log.info("output", "Transcript saved", {"path": str(saved)})
            status = f"Transcript ready — saved to {saved}"
        except (OutputError, OSError) as error:
            self.log.warn("output", "Could not save transcript", str(error))
        self._set_idle_status(status, kind="success")
        if self._should_auto_summarize():
            self._start_summary(auto=True)
        self._schedule_watch_drain()

    def _on_transcribe_failed(self, message: str, origin: str) -> None:
        self._set_busy(False)
        self._transcribe_worker = None
        self.log.error("transcription", "Transcription failed", message)
        self._set_idle_status(f"Transcription failed: {message}", kind="error")
        if origin == "dictation":
            # Dictation happens in another app: a modal here steals focus from
            # the user's work, so the banner carries the failure instead.
            self._banner_message("Transcription failed", BANNER_ERROR, 5000)
        else:
            QMessageBox.warning(self, "Transcription", message)
        self._schedule_watch_drain()

    def _should_auto_summarize(self) -> bool:
        settings = self.settings
        return bool(
            settings.summarization_enabled
            and settings.auto_summarize
            and settings.llm_base_url.strip()
            and settings.llm_model.strip()
            and self.transcript.toPlainText().strip()
        )

    # ------------------------------------------------------------- summary

    def _on_summarize(self) -> None:
        if not self.transcript.toPlainText().strip():
            QMessageBox.information(self, "Summary", "Transcribe something first.")
            return
        if not self.settings.summarization_enabled:
            QMessageBox.information(self, "Summary", "Summaries are disabled in Settings.")
            return
        self._start_summary(auto=False)

    def _start_summary(self, auto: bool) -> None:
        if self._busy or self._summary_worker is not None:
            return
        summarizer = Summarizer(
            self.settings.llm_base_url,
            self.settings.llm_model,
            self.settings.llm_api_key,
            max_tokens=self.settings.llm_max_tokens,
        )
        self.summarize_button.setEnabled(False)
        self._set_idle_status("Summarizing…")
        worker = _SummaryWorker(
            summarizer,
            self.transcript.toPlainText(),
            self.settings.prompt_template,
            self,
        )
        worker.ready.connect(self._on_summary_ready)
        worker.failed.connect(lambda message: self._on_summary_failed(message, auto))
        worker.finished.connect(worker.deleteLater)
        self._summary_worker = worker
        worker.start()

    def _on_summary_ready(self, text: str) -> None:
        self._summary_worker = None
        self.summary.setPlainText(text)
        status = "Summary ready."
        try:
            saved = save_summary(self._output_root(), text)
            self.log.info("output", "Summary saved", {"path": str(saved)})
            status = f"Summary ready — saved to {saved}"
        except (OutputError, OSError) as error:
            self.log.warn("output", "Could not save summary", str(error))
        self._set_idle_status(status, kind="success")
        self.log.info("summary", "Summary completed", {"chars": len(text)})
        self._update_buttons()

    def _on_summary_failed(self, message: str, auto: bool) -> None:
        self._summary_worker = None
        self.log.error("summary", "Summary failed", message)
        self._set_idle_status(f"Summary failed: {message}", kind="error")
        self._update_buttons()
        if not auto:
            QMessageBox.warning(self, "Summary", message)

    # ------------------------------------------------------------ actions

    # ------------------------------------------------------------- drag/drop

    @staticmethod
    def _dropped_audio(mime) -> Path | None:
        if not mime.hasUrls():
            return None
        for url in mime.urls():
            if not url.isLocalFile():
                continue
            path = Path(url.toLocalFile())
            if path.suffix.lower() in AUDIO_SUFFIXES and path.is_file():
                return path
        return None

    def dragEnterEvent(self, event) -> None:  # noqa: N802 - Qt override
        if self._dropped_audio(event.mimeData()) is not None:
            event.acceptProposedAction()
            self._set_idle_status("Drop the audio file to transcribe it.")
        else:
            event.ignore()

    def dropEvent(self, event) -> None:  # noqa: N802 - Qt override
        path = self._dropped_audio(event.mimeData())
        if path is None:
            event.ignore()
            return
        event.acceptProposedAction()
        self.log.info("import", "Dropped audio", {"path": str(path)})
        if self._busy or self._mode or self.dictation.dictating:
            self._watch_queue.append(path)
            self._set_idle_status(f"Queued {path.name}")
            return
        self._start_import(path)

    def _on_import(self) -> None:
        if self._busy:
            return
        file_path, _ = QFileDialog.getOpenFileName(self, "Import audio", str(Path.home()), AUDIO_FILTER)
        if not file_path:
            return
        path = Path(file_path)
        if path.suffix.lower() not in AUDIO_SUFFIXES:
            QMessageBox.warning(self, "Import", f"Unsupported audio format: {path.suffix or 'unknown'}")
            return
        if not path.is_file():
            QMessageBox.warning(self, "Import", "That file no longer exists.")
            return
        self._start_import(path)

    def _schedule_watch_drain(self) -> None:
        if self._watch_queue:
            QTimer.singleShot(0, self._drain_watch_queue)

    def _start_import(self, path: Path) -> None:
        self._segments = []
        self.transcript.clear()
        self.summary.clear()
        self.log.info("import", "Importing audio", {"path": str(path)})
        self._transcribe(path, origin="transcription")

    def _on_watch_file(self, path: str) -> None:
        audio = Path(path)
        if self._busy or self._mode or self.dictation.dictating:
            self._watch_queue.append(audio)
            self.log.info("watch", "Queued audio from watch folder", {"path": str(audio)})
            self._set_idle_status(f"Watch folder: queued {audio.name}")
            return
        self.log.info("watch", "Importing audio from watch folder", {"path": str(audio)})
        self._set_idle_status(f"Watch folder: importing {audio.name}…", kind="busy")
        self._start_import(audio)

    def _drain_watch_queue(self) -> None:
        if self._busy or self._mode or self.dictation.dictating or not self._watch_queue:
            return
        audio = self._watch_queue.pop(0)
        if audio.is_file():
            self.log.info("watch", "Importing queued audio", {"path": str(audio)})
            self._start_import(audio)

    def _export_timed(self, kind: str) -> None:
        if not self._segments:
            QMessageBox.information(self, "Export", "Transcribe audio first — there are no timed segments yet.")
            return
        suffix = "srt" if kind == "srt" else "vtt"
        default_dir = self._output_root() / "transcripts"
        try:
            default_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            default_dir = Path.home()
        default_path = default_dir / f"transcript-{time.strftime('%Y%m%d-%H%M%S')}.{suffix}"
        path, _ = QFileDialog.getSaveFileName(
            self,
            f"Export {suffix.upper()}",
            str(default_path),
            f"{suffix.upper()} (*.{suffix})",
        )
        if not path:
            return
        content = build_srt(self._segments) if kind == "srt" else build_vtt(self._segments)
        try:
            Path(path).write_text(content, encoding="utf-8")
        except OSError as error:
            self.log.error("export", f"Could not write {suffix}", error)
            QMessageBox.warning(self, "Export", f"Could not write the file: {error}")
            return
        self.log.info("export", f"{suffix.upper()} exported", {"path": path, "segments": len(self._segments)})
        self._set_idle_status(f"{suffix.upper()} saved to {path}", kind="success")

    def _on_copy(self) -> None:
        text = self.transcript.toPlainText()
        if not text:
            return
        from PySide6.QtGui import QGuiApplication

        QGuiApplication.clipboard().setText(text)
        self._set_idle_status("Transcript copied.")

    def _on_save(self) -> None:
        text = self.transcript.toPlainText()
        if not text:
            QMessageBox.information(self, "Save", "There is no transcript to save.")
            return
        default_dir = self._output_root() / "transcripts"
        try:
            default_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            default_dir = Path.home()
        default_path = default_dir / f"transcript-{time.strftime('%Y%m%d-%H%M%S')}.txt"
        file_path, _ = QFileDialog.getSaveFileName(self, "Save transcript", str(default_path), "Text (*.txt)")
        if not file_path:
            return
        try:
            Path(file_path).write_text(text, encoding="utf-8")
        except OSError as error:
            self.log.error("transcript", "Could not save transcript", error)
            QMessageBox.warning(self, "Save", f"Could not save the transcript: {error}")
            return
        self._saved_transcript = text
        self._saved_transcript_path = Path(file_path)
        self._set_idle_status(f"Transcript saved to {file_path}")
        self.log.info("transcript", "Transcript saved", {"path": file_path})

    # ------------------------------------------------------------ state

    def _set_busy(self, busy: bool) -> None:
        self._busy = busy
        self._update_buttons()

    def _update_buttons(self) -> None:
        recording = self._mode == "record"
        dictating = self.dictation.dictating
        busy = self._busy
        self.record_button.setEnabled(not busy and not dictating)
        self.import_button.setEnabled(not busy and not recording and not dictating)
        self.dictate_button.setEnabled(not busy and not recording)
        has_text = bool(self.transcript.toPlainText().strip())
        self.copy_button.setEnabled(has_text)
        self.save_button.setEnabled(has_text)
        self.summarize_button.setEnabled(has_text and not busy and self._summary_worker is None)
        self.settings_button.setEnabled(not recording and not dictating)
        if hasattr(self, "export_srt_action"):
            timed = bool(self._segments)
            self.export_srt_action.setEnabled(timed)
            self.export_vtt_action.setEnabled(timed)

    def _set_idle_status(self, message: str, kind: str = "idle") -> None:
        self.status_label.setText(message)
        self._set_status_kind(kind)

    def _set_status_kind(self, kind: str) -> None:
        dot = getattr(self, "status_dot", None)
        if dot is None:
            return
        dot.setProperty("state", kind)
        style = dot.style()
        style.unpolish(dot)
        style.polish(dot)

    def _update_word_count(self) -> None:
        meta = getattr(self, "transcript_meta", None)
        if meta is None:
            return
        words = len(self.transcript.toPlainText().split())
        meta.setText(f"{words} word" if words == 1 else f"{words} words")

    # ------------------------------------------------------------ shutdown

    def _autosave_transcript(self) -> None:
        text = self.transcript.toPlainText()
        if not text.strip():
            return
        try:
            if self._saved_transcript_path is not None:
                self._saved_transcript_path.write_text(text, encoding="utf-8")
                saved = self._saved_transcript_path
            else:
                saved = save_transcript(self._output_root(), text)
        except (OSError, OutputError) as error:
            self.log.warn("output", "Could not autosave transcript", str(error))
            return
        self._saved_transcript = text
        self._saved_transcript_path = saved

    def _confirm_transcript_saved(self) -> bool:
        text = self.transcript.toPlainText()
        if not text.strip() or text == self._saved_transcript:
            return True
        choice = QMessageBox.warning(
            self,
            "Unsaved transcript",
            "Save changes to the transcript before closing?",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Save,
        )
        if choice == QMessageBox.StandardButton.Cancel:
            return False
        if choice == QMessageBox.StandardButton.Discard:
            return True
        return self._save_transcript_now()

    def _save_transcript_now(self) -> bool:
        text = self.transcript.toPlainText()
        try:
            if self._saved_transcript_path is not None:
                self._saved_transcript_path.write_text(text, encoding="utf-8")
                saved = self._saved_transcript_path
            else:
                saved = save_transcript(self._output_root(), text)
        except (OSError, OutputError) as error:
            self.log.error("transcript", "Could not save transcript", error)
            QMessageBox.warning(self, "Save", f"Could not save the transcript: {error}")
            return False
        self._saved_transcript = text
        self._saved_transcript_path = saved
        self._set_idle_status(f"Transcript saved to {saved}")
        return True

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt override
        if not self._confirm_transcript_saved():
            event.ignore()
            return
        try:
            if self.dictation.dictating:
                self.dictation.cancel()
            if self.recorder.is_recording:
                self.recorder.cancel()
            if self.system_recorder.recording:
                try:
                    self.system_recorder.stop()
                except SystemAudioError:
                    pass
                self.system_recorder.cleanup()
            self.dictation.stop_listening()
            if self._recording_hotkey is not None:
                self._recording_hotkey.stop()
                self._recording_hotkey = None
            if self._toast is not None:
                self._toast.close()
                self._toast = None
            for worker in (self._transcribe_worker, self._summary_worker):
                if worker is None:
                    continue
                if worker.isRunning():
                    # Detach from the window so Qt does not destroy a running
                    # QThread; it finishes on its own and its signals are
                    # disconnected when this window is destroyed.
                    worker.setParent(QApplication.instance())
                    self.log.warn(
                        "ui",
                        "Closing while a background worker is still running",
                        {"worker": type(worker).__name__},
                    )
                else:
                    worker.wait(1000)
            self.log.info("ui", "Main window closed")
        finally:
            event.accept()
