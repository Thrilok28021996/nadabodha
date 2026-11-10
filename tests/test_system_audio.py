import wave
from pathlib import Path

import numpy as np
import pytest

from svara import system_audio
from svara.settings import Settings
from svara.system_audio import SystemAudioError, mix_wavs


def _write(path: Path, samples) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(np.array(samples, dtype=np.int16).tobytes())


def test_mix_wavs_sums_and_pads(tmp_path):
    first = tmp_path / "first.wav"
    second = tmp_path / "second.wav"
    output = tmp_path / "mixed.wav"
    _write(first, [1000, -1000, 2000])
    _write(second, [500, 500])
    mix_wavs([first, second], output)
    with wave.open(str(output)) as handle:
        samples = np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16)
    assert samples.tolist() == [1500, -500, 2000]


def test_mix_wavs_clips(tmp_path):
    first = tmp_path / "a.wav"
    second = tmp_path / "b.wav"
    output = tmp_path / "mixed.wav"
    _write(first, [30000, -30000])
    _write(second, [10000, -10000])
    mix_wavs([first, second], output)
    with wave.open(str(output)) as handle:
        samples = np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16)
    assert samples.tolist() == [32767, -32768]


def test_mix_wavs_rejects_wrong_format(tmp_path):
    path = tmp_path / "odd.wav"
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(44100)
        handle.writeframes(b"\x00\x00" * 8)
    with pytest.raises(SystemAudioError):
        mix_wavs([path], tmp_path / "out.wav")


def test_helper_path_missing_in_empty_bundle(monkeypatch, tmp_path):
    monkeypatch.setattr(system_audio, "helper_path", lambda: None)
    monkeypatch.setattr(system_audio.sys, "platform", "darwin")
    assert system_audio.available() is False


def test_audio_source_defaults_and_validation():
    assert Settings().audio_source == "microphone"
    assert Settings.from_dict({"audio_source": "both"}).audio_source == "both"
    assert Settings.from_dict({"audio_source": "nonsense"}).audio_source == "microphone"
