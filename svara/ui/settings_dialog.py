"""Settings dialog: model, local LLM, dictation and prompt configuration."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from ..hotkey import HotkeyError, parse_hotkey
from ..settings import KNOWN_LANGUAGES, Settings
from ..summarizer import SummarizationError, list_models, probe_model
from .theme import FLAVOR_LABELS


class SettingsDialog(QDialog):
    def __init__(self, settings: Settings, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Svara Settings")
        self.setModal(True)
        self.setMinimumWidth(620)
        self._settings = replace(settings, prompt_presets=[dict(item) for item in settings.prompt_presets])

        self._model = QLineEdit(settings.model_repo)
        self._model.setPlaceholderText("deepdml/faster-whisper-large-v3-turbo-ct2")

        self._cache = QLineEdit(settings.stt_cache_dir)
        self._cache.setPlaceholderText("~/.cache/huggingface")
        browse = QPushButton("Browse…")
        browse.clicked.connect(self._browse_cache)
        cache_row = QHBoxLayout()
        cache_row.addWidget(self._cache, 1)
        cache_row.addWidget(browse)

        self._backend = QComboBox()
        self._backend.addItem("Automatic (GPU when available)", "auto")
        self._backend.addItem("Apple GPU (MLX)", "mlx")
        self._backend.addItem("CPU only", "cpu")
        index = self._backend.findData(settings.stt_backend)
        self._backend.setCurrentIndex(index if index >= 0 else 0)
        self._backend.setToolTip(
            "The Apple GPU path runs the same large-v3-turbo weights in float16 and\n"
            "measured about 5x faster than the CPU path on a dictation-length clip.\n"
            "CPU is the fallback whenever MLX or Metal is unavailable."
        )

        self._output = QLineEdit(settings.output_dir)
        self._output.setPlaceholderText("/Volumes/personal/meetings")
        browse_output = QPushButton("Browse…")
        browse_output.clicked.connect(self._browse_output)
        output_row = QHBoxLayout()
        output_row.addWidget(self._output, 1)
        output_row.addWidget(browse_output)

        self._theme = QComboBox()
        for key, label in FLAVOR_LABELS.items():
            self._theme.addItem(label, key)
        index = self._theme.findData(settings.theme)
        self._theme.setCurrentIndex(index if index >= 0 else 0)

        self._device = QComboBox()
        self._device.addItem("System default", "")
        try:
            import sounddevice as sd

            for device_index, info in enumerate(sd.query_devices()):
                if int(info.get("max_input_channels", 0)) > 0:
                    self._device.addItem(f"{device_index}: {info['name']}", str(device_index))
        except Exception:  # noqa: BLE001 - device list is best effort
            pass
        device_index = self._device.findData(settings.input_device)
        self._device.setCurrentIndex(device_index if device_index >= 0 else 0)

        self._source = QComboBox()
        for key, label in (
            ("microphone", "Microphone"),
            ("system", "System audio (other apps)"),
            ("both", "Microphone + system audio"),
        ):
            self._source.addItem(label, key)
        source_index = self._source.findData(settings.audio_source)
        self._source.setCurrentIndex(source_index if source_index >= 0 else 0)

        self._max_minutes = QSpinBox()
        self._max_minutes.setRange(0, 480)
        self._max_minutes.setSuffix(" min")
        self._max_minutes.setSpecialValueText("Unlimited")
        self._max_minutes.setValue(settings.max_recording_minutes)

        self._watch = QLineEdit(settings.watch_folder)
        self._watch.setPlaceholderText("Optional: auto-import audio dropped in this folder")
        browse_watch = QPushButton("Browse…")
        browse_watch.clicked.connect(self._browse_watch)
        watch_row = QHBoxLayout()
        watch_row.addWidget(self._watch, 1)
        watch_row.addWidget(browse_watch)

        self._url = QLineEdit(settings.llm_base_url)
        self._url.setPlaceholderText("http://127.0.0.1:1234/v1")
        self._llm_model = QLineEdit(settings.llm_model)
        self._llm_model.setPlaceholderText("the model your local server serves")
        test_connection = QPushButton("Test connection")
        test_connection.clicked.connect(self._test_connection)
        list_models_button = QPushButton("List models…")
        list_models_button.clicked.connect(self._choose_model)
        model_row = QHBoxLayout()
        model_row.addWidget(self._llm_model, 1)
        model_row.addWidget(test_connection)
        model_row.addWidget(list_models_button)
        self._api_key = QLineEdit(settings.llm_api_key)
        self._api_key.setEchoMode(QLineEdit.EchoMode.Password)
        self._api_key.setPlaceholderText("optional")
        self._max_tokens = QSpinBox()
        self._max_tokens.setRange(256, 16384)
        self._max_tokens.setSingleStep(512)
        self._max_tokens.setSuffix(" tokens")
        self._max_tokens.setValue(settings.llm_max_tokens)

        self._summarization = QCheckBox("Enable summaries")
        self._summarization.setChecked(settings.summarization_enabled)
        self._auto_summary = QCheckBox("Summarize automatically after transcription")
        self._auto_summary.setChecked(settings.auto_summarize)

        self._dictation = QCheckBox("Enable global dictation hotkey")
        self._dictation.setChecked(settings.dictation_enabled)
        self._paste = QCheckBox("Paste dictated text at the cursor")
        self._paste.setChecked(settings.dictation_paste_enabled)
        self._chime = QCheckBox("Play a chime when dictation is ready")
        self._chime.setChecked(settings.dictation_chime)
        self._notification = QCheckBox("Show a notification when text is on the clipboard")
        self._notification.setChecked(settings.dictation_notification)
        self._hotkey = QLineEdit(settings.dictation_hotkey)
        self._hotkey.setPlaceholderText("<alt>+<space>")
        self._recording_hotkey = QLineEdit(settings.recording_hotkey)
        self._recording_hotkey.setPlaceholderText("<cmd>+<shift>+r")

        self._language = QLineEdit(settings.dictation_language)
        self._language.setPlaceholderText("en")
        self._language.setToolTip(
            "A language code such as en, or auto to let Whisper detect it.\n"
            "Detection is a whole extra pass over the 30s window, which is why a\n"
            "pinned language makes dictation noticeably faster."
        )
        self._preload = QCheckBox("Load the speech model at startup (faster first dictation)")
        self._preload.setChecked(settings.preload_model)
        self._preload.setToolTip(
            "Keeps about 1.6 GB resident so the first dictation does not wait for\n"
            "the model to load. Turn off on a memory-constrained machine."
        )

        self._prompt = QPlainTextEdit(settings.prompt_template)
        self._prompt.setMinimumHeight(170)

        self._preset = QComboBox()
        for preset in settings.prompt_presets:
            self._preset.addItem(preset["name"])
        self._preset.currentIndexChanged.connect(self._apply_preset)
        save_preset = QPushButton("Save as preset…")
        save_preset.clicked.connect(self._save_preset)
        preset_row = QHBoxLayout()
        preset_row.addWidget(self._preset, 1)
        preset_row.addWidget(save_preset)

        def group(text: str) -> QLabel:
            label = QLabel(text)
            label.setObjectName("groupTitle")
            return label

        form = QFormLayout()
        form.setSpacing(10)
        form.setLabelAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        form.addRow("Speech model", self._model)
        form.addRow("Transcription engine", self._backend)
        form.addRow("Model cache", cache_row)
        form.addRow("Output folder", output_row)
        form.addRow("Appearance", self._theme)
        form.addRow("Input device", self._device)
        form.addRow("Record from", self._source)
        form.addRow("Max recording", self._max_minutes)
        form.addRow("Watch folder", watch_row)
        form.addRow(QLabel(""))
        form.addRow(group("SUMMARIZATION"))
        form.addRow("Server URL", self._url)
        form.addRow("Model", model_row)
        form.addRow("API key", self._api_key)
        form.addRow("Max tokens", self._max_tokens)
        form.addRow("", self._summarization)
        form.addRow("", self._auto_summary)
        form.addRow(QLabel(""))
        form.addRow(group("DICTATION"))
        form.addRow("Recording hotkey", self._recording_hotkey)
        form.addRow("Dictation hotkey", self._hotkey)
        form.addRow("Dictation language", self._language)
        form.addRow("", self._preload)
        form.addRow("", self._dictation)
        form.addRow("", self._paste)
        form.addRow("", self._chime)
        form.addRow("", self._notification)
        form.addRow(QLabel(""))
        form.addRow(group("SUMMARIZATION PROMPT"))
        form.addRow("Preset", preset_row)
        form.addRow("Prompt", self._prompt)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self._on_accept)
        buttons.rejected.connect(self.reject)

        content = QWidget()
        content_layout = QVBoxLayout(content)
        content_layout.setContentsMargins(0, 0, 6, 0)
        content_layout.setSpacing(10)
        content_layout.addLayout(form)
        content_layout.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setWidget(content)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 18, 18, 16)
        layout.setSpacing(12)
        heading = QLabel("Settings")
        heading.setObjectName("dialogHeading")
        layout.addWidget(heading)
        layout.addWidget(scroll, 1)
        layout.addWidget(buttons)

        screen = QGuiApplication.primaryScreen()
        available = screen.availableGeometry().height() if screen is not None else 900
        self.resize(680, min(780, max(560, int(available * 0.86))))

    # -- actions -----------------------------------------------------------

    def _browse_cache(self) -> None:
        directory = QFileDialog.getExistingDirectory(self, "Choose model cache directory", self._cache.text())
        if directory:
            self._cache.setText(directory)

    def _browse_output(self) -> None:
        directory = QFileDialog.getExistingDirectory(self, "Choose output folder", self._output.text())
        if directory:
            self._output.setText(directory)

    def _browse_watch(self) -> None:
        directory = QFileDialog.getExistingDirectory(self, "Choose watch folder", self._watch.text())
        if directory:
            self._watch.setText(directory)

    def _test_connection(self) -> None:
        url = self._url.text().strip()
        model = self._llm_model.text().strip()
        try:
            models = list_models(url, self._api_key.text().strip())
        except SummarizationError as error:
            QMessageBox.warning(self, "Summary server", str(error))
            return
        if not models:
            QMessageBox.information(self, "Summary server", "The server answered but advertises no models.")
            return
        if not model:
            QMessageBox.information(
                self, "Summary server", f"Connected — {len(models)} model(s):\n" + ", ".join(models[:8])
            )
            return
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            seconds = probe_model(url, model, self._api_key.text().strip())
        except SummarizationError as error:
            QApplication.restoreOverrideCursor()
            QMessageBox.warning(self, "Summary model", str(error))
            return
        QApplication.restoreOverrideCursor()
        QMessageBox.information(
            self, "Summary model", f"{model} answered in {seconds:.1f}s."
        )

    def _choose_model(self) -> None:
        try:
            models = list_models(self._url.text().strip(), self._api_key.text().strip())
        except SummarizationError as error:
            QMessageBox.warning(self, "Summary server", str(error))
            return
        if not models:
            QMessageBox.information(self, "Summary server", "The server advertises no models.")
            return
        choice, accepted = QInputDialog.getItem(self, "Models", "Choose a model:", models, 0, False)
        if accepted and choice:
            self._llm_model.setText(choice)

    def _apply_preset(self, index: int) -> None:
        presets = self._settings.prompt_presets
        if 0 <= index < len(presets):
            self._prompt.setPlainText(presets[index]["template"])

    def _save_preset(self) -> None:
        name, accepted = QInputDialog.getText(self, "Save preset", "Preset name:")
        template = self._prompt.toPlainText().strip()
        if not accepted or not name.strip() or not template:
            return
        presets = self._settings.prompt_presets
        presets.append({"name": name.strip(), "template": template})
        self._preset.addItem(name.strip())
        self._preset.setCurrentIndex(len(presets) - 1)

    def _on_accept(self) -> None:
        model = self._model.text().strip()
        if not model:
            QMessageBox.warning(self, "Settings", "The speech model cannot be empty.")
            return
        if "/" not in model or any(character.isspace() for character in model):
            QMessageBox.warning(self, "Settings", "Enter a Hugging Face model id such as org/model.")
            return
        cache = self._cache.text().strip()
        if cache:
            cache_path = Path(cache).expanduser()
            try:
                cache_path.mkdir(parents=True, exist_ok=True)
            except OSError as error:
                QMessageBox.warning(
                    self,
                    "Settings",
                    f"The model cache folder cannot be created:\n{cache_path}\n{error}",
                )
                return
        output = self._output.text().strip() or "/Volumes/personal/meetings"
        try:
            Path(output).expanduser().mkdir(parents=True, exist_ok=True)
        except OSError as error:
            QMessageBox.warning(self, "Settings", f"The output folder cannot be used:\n{error}")
            return
        watch = self._watch.text().strip()
        if watch and not Path(watch).expanduser().is_dir():
            QMessageBox.warning(self, "Settings", f"The watch folder does not exist:\n{watch}")
            return
        url = self._url.text().strip()
        if url and not url.lower().startswith(("http://", "https://")):
            QMessageBox.warning(self, "Settings", "The summary server URL must start with http:// or https://.")
            return
        hotkey = self._hotkey.text().strip()
        if self._dictation.isChecked() and not hotkey:
            QMessageBox.warning(self, "Settings", "Enter a hotkey, for example <alt>+<space>.")
            return
        language = self._language.text().strip()
        if language and language.lower() != "auto":
            base = language.lower().split("-")[0]
            if base not in KNOWN_LANGUAGES:
                QMessageBox.warning(
                    self,
                    "Settings",
                    f"Unknown dictation language {language!r}. Use a code such as en, "
                    "pt-BR, or auto.",
                )
                return
        recording_hotkey = self._recording_hotkey.text().strip()
        if recording_hotkey and recording_hotkey.lower() == hotkey.lower():
            QMessageBox.warning(self, "Settings", "The recording and dictation hotkeys must differ.")
            return
        for label, value in (("Dictation", hotkey), ("Recording", recording_hotkey)):
            if not value:
                continue
            try:
                parse_hotkey(value)
            except HotkeyError as error:
                QMessageBox.warning(self, "Settings", f"{label} hotkey: {error}")
                return

        self._settings.model_repo = model
        self._settings.stt_cache_dir = self._cache.text().strip()
        self._settings.stt_backend = self._backend.currentData() or "auto"
        self._settings.output_dir = output
        self._settings.theme = self._theme.currentData() or "mocha"
        self._settings.input_device = self._device.currentData() or ""
        self._settings.audio_source = self._source.currentData() or "microphone"
        self._settings.max_recording_minutes = self._max_minutes.value()
        self._settings.watch_folder = watch
        self._settings.llm_base_url = url
        self._settings.llm_model = self._llm_model.text().strip()
        self._settings.llm_api_key = self._api_key.text().strip()
        self._settings.llm_max_tokens = self._max_tokens.value()
        self._settings.summarization_enabled = self._summarization.isChecked()
        self._settings.auto_summarize = self._auto_summary.isChecked()
        self._settings.dictation_enabled = self._dictation.isChecked()
        self._settings.dictation_paste_enabled = self._paste.isChecked()
        self._settings.dictation_chime = self._chime.isChecked()
        self._settings.dictation_notification = self._notification.isChecked()
        self._settings.dictation_hotkey = hotkey or "<alt>+<space>"
        self._settings.recording_hotkey = recording_hotkey or "<cmd>+<shift>+r"
        self._settings.dictation_language = self._language.text().strip() or "en"
        self._settings.preload_model = self._preload.isChecked()
        self._settings.prompt_template = self._prompt.toPlainText() or self._settings.prompt_template
        self.accept()

    def result_settings(self) -> Settings:
        return self._settings
