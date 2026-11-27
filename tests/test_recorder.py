import wave
from pathlib import Path

import numpy as np
import pytest

from svara import recorder as recorder_module
from svara.recorder import (
    MICROPHONE_DENIED_MESSAGE,
    Recorder,
    RecorderError,
    persist_recording,
)

BLOCK = 1600  # 0.1 s at 16 kHz


class FakeStream:
    """PortAudio stand-in that pushes a fixed number of sample blocks."""

    def __init__(self, callback, blocks: int = 10, value: int = 1200) -> None:
        self.callback = callback
        self.blocks = blocks
        self.value = value
        self.started = False
        self.stopped = False
        self.closed = False

    def start(self) -> None:
        self.started = True
        for _ in range(self.blocks):
            data = np.full((BLOCK, 1), self.value, dtype=np.int16)
            self.callback(data, BLOCK, None, None)

    def stop(self) -> None:
        self.stopped = True

    def close(self) -> None:
        self.closed = True


def install_fake_stream(monkeypatch, blocks: int = 10, value: int = 1200):
    created = []

    def fake_open(samplerate, channels, callback, device=""):
        stream = FakeStream(callback, blocks=blocks, value=value)
        created.append(stream)
        stream.start()
        return stream

    monkeypatch.setattr(recorder_module, "_open_stream", fake_open)
    return created


def test_records_full_duration_and_valid_wav(monkeypatch, tmp_path):
    install_fake_stream(monkeypatch, blocks=10)
    recorder = Recorder()
    output = recorder.start()
    assert recorder.is_recording
    assert output.parent.name.startswith("svara-")
    result = recorder.stop()
    assert result == output
    with wave.open(str(output), "rb") as handle:
        assert handle.getframerate() == 16000
        assert handle.getnchannels() == 1
        assert handle.getsampwidth() == 2
        assert handle.getnframes() == 10 * BLOCK
    assert not recorder.is_recording


def test_varied_block_sizes_are_concatenated(monkeypatch, tmp_path):
    def fake_open(samplerate, channels, callback, device=""):
        stream = FakeStream(callback, blocks=0)
        stream.callback(np.zeros((800, 1), dtype=np.int16), 800, None, None)
        stream.callback(np.zeros((3200, 1), dtype=np.int16), 3200, None, None)
        return stream

    monkeypatch.setattr(recorder_module, "_open_stream", fake_open)
    recorder = Recorder()
    recorder.start()
    output = recorder.stop()
    with wave.open(str(output), "rb") as handle:
        assert handle.getnframes() == 4000


def test_no_audio_is_an_error(monkeypatch):
    install_fake_stream(monkeypatch, blocks=0)
    recorder = Recorder()
    recorder.start()
    with pytest.raises(RecorderError) as captured:
        recorder.stop()
    assert "no audio" in str(captured.value)


def test_stream_is_stopped_and_closed(monkeypatch):
    created = install_fake_stream(monkeypatch, blocks=2)
    recorder = Recorder()
    recorder.start()
    recorder.stop()
    assert created[0].stopped and created[0].closed


def test_permission_error_gets_guidance(monkeypatch):
    def fake_open(samplerate, channels, callback):
        raise RuntimeError("PortAudioError: permission denied by the OS")

    monkeypatch.setattr(recorder_module, "_open_stream", fake_open)
    with pytest.raises(RecorderError) as captured:
        Recorder().start()
    assert str(captured.value) == MICROPHONE_DENIED_MESSAGE


def test_other_start_failures_are_reported(monkeypatch):
    def fake_open(samplerate, channels, callback, device=""):
        raise RuntimeError("device is busy")

    monkeypatch.setattr(recorder_module, "_open_stream", fake_open)
    with pytest.raises(RecorderError) as captured:
        Recorder().start()
    assert "device is busy" in str(captured.value)


def test_cancel_removes_the_temporary_recording(monkeypatch):
    install_fake_stream(monkeypatch, blocks=4)
    recorder = Recorder()
    output = recorder.start()
    temp_dir = output.parent
    recorder.cancel()
    assert not output.exists()
    assert not temp_dir.exists()
    assert not recorder.is_recording


def test_elapsed_seconds_tracks_capture_time(monkeypatch):
    install_fake_stream(monkeypatch, blocks=1)
    recorder = Recorder()
    recorder.start()
    assert recorder.elapsed_seconds() >= 0
    recorder.cancel()


def test_persist_recording_copies_and_names_uniquely(tmp_path):
    source = tmp_path / "temp.wav"
    source.write_bytes(b"audio-bytes")
    target = tmp_path / "recordings"
    first = persist_recording(source, target)
    second = persist_recording(source, target)
    assert first.parent == target
    assert first.suffix == ".wav"
    assert first.read_bytes() == b"audio-bytes"
    assert first != second


def test_persist_recording_rejects_empty_source(tmp_path):
    source = tmp_path / "empty.wav"
    source.write_bytes(b"")
    with pytest.raises(RecorderError):
        persist_recording(source, tmp_path / "recordings")


def test_stop_measures_rms(monkeypatch):
    install_fake_stream(monkeypatch)
    recorder = Recorder()
    recorder.start()
    recorder.stop()
    assert recorder.last_rms > 0


def test_silent_take_has_zero_rms(monkeypatch):
    install_fake_stream(monkeypatch, value=0)
    recorder = Recorder()
    recorder.start()
    recorder.stop()
    assert recorder.last_rms == 0.0


def test_input_device_is_passed_to_portaudio(monkeypatch):
    seen = {}

    def fake_open(samplerate, channels, callback, device=""):
        seen["device"] = device
        stream = FakeStream(callback)
        stream.start()
        return stream

    monkeypatch.setattr(recorder_module, "_open_stream", fake_open)
    recorder = Recorder(input_device="3")
    recorder.start()
    recorder.stop()
    assert seen["device"] == "3"


def test_cleanup_stale_temp_dirs_removes_old_dirs(monkeypatch, tmp_path):
    import os
    import time

    monkeypatch.setattr(recorder_module.tempfile, "gettempdir", lambda: str(tmp_path))
    old = tmp_path / "svara-old"
    old.mkdir()
    fresh = tmp_path / "svara-fresh"
    fresh.mkdir()
    stale_time = time.time() - 48 * 3600
    os.utime(old, (stale_time, stale_time))
    removed = recorder_module.cleanup_stale_temp_dirs()
    assert removed == 1
    assert not old.exists()
    assert fresh.exists()


def test_device_selector_converts_numeric_index():
    from svara.recorder import _device_selector

    assert _device_selector("0") == 0
    assert _device_selector(" 2 ") == 2
    assert _device_selector("MacBook Air Microphone") == "MacBook Air Microphone"
    assert _device_selector("") is None
