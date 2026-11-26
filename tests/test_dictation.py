"""Dictation controller: state machine, guards and the transcribe flags.

The controller is the riskiest piece of dictation: it is driven by a global
hotkey that can fire while another recording is already running, and it has to
hand the finished take back exactly once. None of that was covered before.

The second half pins the flags the dictation path sends to Whisper. Pinning the
language and dropping timestamp tokens are the two measurable latency wins, so
they must not silently drift back onto the recording/import path (which needs
timestamps for SRT/VTT export).
"""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

from svara.dictation import DictationController
from svara.recorder import RecorderError
from svara.settings import Settings


class FakeRecorder:
    """Minimal stand-in for ``Recorder``; records what the controller asked."""

    def __init__(self, fail_start=None, fail_stop=None):
        self.is_recording = False
        self.starts = 0
        self.stops = 0
        self.cancels = 0
        self._fail_start = fail_start
        self._fail_stop = fail_stop

    def start(self):
        if self._fail_start:
            raise RecorderError(self._fail_start)
        self.starts += 1
        self.is_recording = True
        return "/tmp/take.wav"

    def stop(self):
        if self._fail_stop:
            raise RecorderError(self._fail_stop)
        self.stops += 1
        self.is_recording = False
        return "/tmp/take.wav"

    def cancel(self):
        self.cancels += 1
        self.is_recording = False


def make_controller(recorder=None, **kwargs):
    controller = DictationController(recorder or FakeRecorder(), "<alt>+<space>", **kwargs)
    # The hotkey listener is not started: these tests drive toggle() directly.
    return controller


# -- state machine ---------------------------------------------------------


def test_toggle_starts_then_finishes():
    recorder = FakeRecorder()
    controller = make_controller(recorder)
    started, finished = [], []
    controller.started.connect(lambda: started.append(True))
    controller.finished.connect(finished.append)

    controller.toggle()
    assert controller.dictating
    assert recorder.starts == 1
    assert started == [True]

    controller.toggle()
    assert not controller.dictating
    assert recorder.stops == 1
    assert finished == ["/tmp/take.wav"]


def test_start_failure_is_reported_and_leaves_state_clean():
    controller = make_controller(FakeRecorder(fail_start="Microphone access denied"))
    failures = []
    controller.failed.connect(failures.append)

    controller.toggle()
    assert failures == ["Microphone access denied"]
    assert not controller.dictating


def test_stop_failure_is_reported_and_ends_the_take():
    controller = make_controller(FakeRecorder(fail_stop="no audio was captured"))
    failures = []
    controller.failed.connect(failures.append)

    controller.toggle()
    controller.toggle()
    assert failures == ["no audio was captured"]
    assert not controller.dictating


def test_never_hijacks_an_in_flight_recording():
    recorder = FakeRecorder()
    controller = make_controller(recorder)

    recorder.is_recording = True  # a manual recording owns the microphone
    controller.toggle()
    assert recorder.starts == 0
    assert not controller.dictating


def test_guard_blocks_a_take():
    recorder = FakeRecorder()
    controller = make_controller(recorder)
    controller.set_guard(lambda: False)

    controller.toggle()
    assert recorder.starts == 0
    assert not controller.dictating

    controller.set_guard(lambda: True)
    controller.toggle()
    assert recorder.starts == 1


def test_cancel_discards_the_take_without_stopping_it():
    recorder = FakeRecorder()
    controller = make_controller(recorder)

    controller.toggle()
    controller.cancel()
    assert not controller.dictating
    assert recorder.cancels == 1
    assert recorder.stops == 0


def test_finish_without_a_take_is_a_no_op():
    recorder = FakeRecorder()
    controller = make_controller(recorder)
    controller.finish()
    assert recorder.stops == 0


# -- transcribe flags ------------------------------------------------------


def test_dictation_pins_language_and_drops_timestamps():
    from svara.ui.main_window import transcribe_options

    settings = Settings(dictation_language="en")
    options = transcribe_options("dictation", settings)
    assert options == {"without_timestamps": True, "language": "en", "allow_gpu": True}


def test_dictation_language_auto_lets_whisper_detect():
    from svara.ui.main_window import transcribe_options

    settings = Settings(dictation_language="auto")
    options = transcribe_options("dictation", settings)
    assert options["without_timestamps"] is True
    assert "language" not in options


def test_meetings_keep_timestamps_and_auto_detection():
    """The production origin is "transcription" for both recording and import."""
    from svara.ui.main_window import transcribe_options

    settings = Settings(dictation_language="en")
    options = transcribe_options("transcription", settings)
    # No language pin (may not be English) and no timestamp stripping (SRT
    # export needs it) -- and above all, no GPU, because mlx_whisper has no beam
    # search or VAD and would change how meetings are decoded.
    assert "language" not in options
    assert "without_timestamps" not in options
    assert options["allow_gpu"] is False


def test_unknown_origin_keeps_the_cpu_decoding_path():
    from svara.ui.main_window import transcribe_options

    assert transcribe_options("anything-else", Settings())["allow_gpu"] is False


def test_settings_normalise_dictation_language():
    assert Settings.from_dict({"dictation_language": ""}).dictation_language == "en"
    assert Settings.from_dict({"dictation_language": "PT-BR"}).dictation_language == "pt-br"
    assert Settings.from_dict({"dictation_language": "auto"}).dictation_language == "auto"
    assert Settings().dictation_language == "en"


def test_unknown_language_is_rejected_at_save_time_not_mid_dictation():
    # Handing junk to Whisper raises during the user's next take; catching it
    # when the settings load keeps the failure at a fixable moment.
    assert Settings.from_dict({"dictation_language": "banana"}).dictation_language == "en"
    assert Settings.from_dict({"dictation_language": "123"}).dictation_language == "en"
    assert Settings.from_dict({"dictation_language": "es"}).dictation_language == "es"


def test_preload_defaults_on_and_round_trips(tmp_path):
    path = tmp_path / "settings.json"
    settings = Settings(preload_model=False)
    settings.save(path)
    assert Settings.load(path).preload_model is False
    assert Settings().preload_model is True


# -- hotkey listener fallback ---------------------------------------------


def test_carbon_failure_without_accessibility_reports_instead_of_failing_silently(monkeypatch):
    from svara import dictation as module

    class BoomCarbon:
        def __init__(self, *args, **kwargs):
            raise module.CarbonHotkey.__mro__[0].__name__ and RuntimeError("RegisterEventHotKey failed")

    monkeypatch.setattr(module, "CarbonHotkey", BoomCarbon)
    monkeypatch.setattr(module, "accessibility_trusted", lambda: False)

    controller = make_controller()
    events = []
    controller.listening_changed.connect(lambda ok, message: events.append((ok, message)))
    controller.start_listening()

    assert controller.listening is False
    assert events and events[0][0] is False
    assert "Accessibility" in events[0][1]


def test_carbon_failure_falls_back_to_pynput_when_trusted(monkeypatch):
    import sys
    import types

    from svara import dictation as module

    class BoomCarbon:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("carbon unavailable")

    started = []

    class FakeGlobalHotKeys:
        def __init__(self, mapping):
            started.append(mapping)

        def start(self):
            pass

        def stop(self):
            pass

    fake = types.ModuleType("pynput")
    keyboard = types.ModuleType("pynput.keyboard")
    keyboard.GlobalHotKeys = FakeGlobalHotKeys
    fake.keyboard = keyboard
    monkeypatch.setitem(sys.modules, "pynput", fake)
    monkeypatch.setitem(sys.modules, "pynput.keyboard", keyboard)
    monkeypatch.setattr(module, "CarbonHotkey", BoomCarbon)
    monkeypatch.setattr(module, "accessibility_trusted", lambda: True)

    controller = make_controller()
    events = []
    controller.listening_changed.connect(lambda ok, message: events.append((ok, message)))
    controller.start_listening()

    assert started == [{"<alt>+<space>": controller._request_toggle}]
    assert controller.listening is True
    assert events == [(True, "")]


# -- model reuse -----------------------------------------------------------


def test_settings_change_rebuilds_the_transcriber_only_when_the_model_changes():
    from PySide6.QtWidgets import QApplication

    from svara.logging_setup import init_logging
    from svara.ui.main_window import MainWindow

    import tempfile
    from pathlib import Path

    app = QApplication.instance() or QApplication([])
    with tempfile.TemporaryDirectory() as temporary:
        logger = init_logging(Path(temporary) / "logs" / "svara.log")
        settings = Settings(dictation_enabled=False)
        window = MainWindow(settings=settings, settings_path=Path(temporary) / "settings.json", logger=logger)
        try:
            first = window._transcriber()
            # A theme change must not throw away a loaded 1.6 GB model.
            window.settings.theme = "latte"
            window._apply_settings()
            assert window._transcriber() is first

            # A model change must.
            window.settings.model_repo = "Systran/faster-whisper-small"
            window._apply_settings()
            assert window._transcriber() is not first
        finally:
            window.close()
            app.processEvents()
