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
    assert options == {"without_timestamps": True, "language": "en"}


def test_dictation_language_auto_lets_whisper_detect():
    from svara.ui.main_window import transcribe_options

    settings = Settings(dictation_language="auto")
    options = transcribe_options("dictation", settings)
    assert options == {"without_timestamps": True}
    assert "language" not in options


def test_meetings_keep_timestamps_and_auto_detection():
    from svara.ui.main_window import transcribe_options

    settings = Settings(dictation_language="en")
    for origin in ("record", "import", "watch", "library"):
        assert transcribe_options(origin, settings) == {}


def test_settings_normalise_dictation_language():
    assert Settings.from_dict({"dictation_language": ""}).dictation_language == "en"
    assert Settings.from_dict({"dictation_language": "PT-BR"}).dictation_language == "pt-br"
    assert Settings.from_dict({"dictation_language": "auto"}).dictation_language == "auto"
    assert Settings().dictation_language == "en"


def test_preload_defaults_on_and_round_trips(tmp_path):
    path = tmp_path / "settings.json"
    settings = Settings(preload_model=False)
    settings.save(path)
    assert Settings.load(path).preload_model is False
    assert Settings().preload_model is True
