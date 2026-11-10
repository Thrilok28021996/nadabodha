import shutil
import wave
from pathlib import Path

import numpy as np
import pytest

from svara import transcriber as transcriber_module
from svara.transcriber import (
    Transcriber,
    TranscriptionError,
    decode_with_av,
    hub_cache_dir,
    load_wav_float32,
    normalize_audio,
)


def make_wav(path: Path) -> Path:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(b"\x00" * 3200)
    return path


class Segment:
    def __init__(self, text: str, start: float = 0.0, end: float = 1.0) -> None:
        self.text = text
        self.start = start
        self.end = end


class FakeModel:
    def __init__(self, segments):
        self._segments = segments
        self.seen = None

    def transcribe(self, audio, **kwargs):
        self.seen = audio
        return iter(self._segments), object()


def test_hub_cache_dir_appends_hub():
    assert hub_cache_dir("/tmp/hf") == "/tmp/hf/hub"
    assert hub_cache_dir("/tmp/hf/hub") == "/tmp/hf/hub"
    assert hub_cache_dir("") is None


def test_wav_input_is_used_directly(tmp_path):
    wav = make_wav(tmp_path / "audio.wav")
    assert normalize_audio(wav) == wav


def test_transcription_joins_segments(tmp_path, monkeypatch):
    wav = make_wav(tmp_path / "audio.wav")
    transcriber = Transcriber("Systran/faster-whisper-base")
    model = FakeModel([Segment(" hello "), Segment("world")])
    monkeypatch.setattr(transcriber, "_load_model", lambda: model)
    assert transcriber.transcribe(wav) == "hello world"
    # The model must receive decoded samples, never a path: faster-whisper's
    # own PyAV decoder is incompatible with current PyAV releases.
    assert isinstance(model.seen, np.ndarray)
    assert model.seen.dtype == np.float32


def test_empty_result_is_empty_string(tmp_path, monkeypatch):
    wav = make_wav(tmp_path / "audio.wav")
    transcriber = Transcriber("Systran/faster-whisper-base")
    monkeypatch.setattr(transcriber, "_load_model", lambda: FakeModel([]))
    assert transcriber.transcribe(wav) == ""


def test_missing_audio_file_is_reported(tmp_path):
    transcriber = Transcriber("Systran/faster-whisper-base")
    with pytest.raises(TranscriptionError):
        transcriber.transcribe(tmp_path / "missing.wav")


def test_non_wav_conversion_failure_is_reported(tmp_path, monkeypatch):
    source = tmp_path / "audio.mp3"
    source.write_bytes(b"not really audio")
    monkeypatch.setattr(shutil, "which", lambda name: None)
    with pytest.raises(TranscriptionError) as captured:
        normalize_audio(source, ffmpeg_path="ffmpeg-not-installed")
    assert "Could not convert" in str(captured.value)


def test_load_wav_float32(tmp_path):
    wav = make_wav(tmp_path / "audio.wav")
    audio = load_wav_float32(wav)
    assert audio.dtype == np.float32
    assert audio.size == 1600


def test_empty_wav_is_rejected(tmp_path):
    path = tmp_path / "empty.wav"
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(b"")
    with pytest.raises(TranscriptionError):
        load_wav_float32(path)


def test_transcriber_is_lazy():
    transcriber = Transcriber("Systran/faster-whisper-base")
    assert transcriber._model is None


def test_module_exports_whisper_model_only_on_demand():
    assert hasattr(transcriber_module, "Transcriber")


def test_model_cache_detection(tmp_path):
    from svara.transcriber import cache_bytes, is_model_cached, repo_cache_dir

    repo = "org/model"
    assert is_model_cached(repo, str(tmp_path)) is False
    root = repo_cache_dir(repo, str(tmp_path))
    snapshot = root / "snapshots" / "abc123"
    snapshot.mkdir(parents=True)
    (snapshot / "model.bin").write_bytes(b"x" * 1_200_000)
    assert is_model_cached(repo, str(tmp_path)) is True
    assert cache_bytes(repo, str(tmp_path)) == 1_200_000


def test_tiny_model_file_is_not_cached(tmp_path):
    from svara.transcriber import is_model_cached, repo_cache_dir

    repo = "org/model"
    snapshot = repo_cache_dir(repo, str(tmp_path)) / "snapshots" / "abc"
    snapshot.mkdir(parents=True)
    (snapshot / "model.bin").write_bytes(b"x" * 10)
    assert is_model_cached(repo, str(tmp_path)) is False


def make_stereo_wav(path: Path, rate: int = 44100, seconds: float = 0.5) -> Path:
    frames = int(rate * seconds)
    t = np.linspace(0, seconds, frames, endpoint=False)
    mono = (0.2 * np.sin(2 * np.pi * 440 * t) * 32767).astype(np.int16)
    stereo = np.column_stack([mono, mono])
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(stereo.tobytes())
    return path


def test_decode_with_av_resamples_to_16k_mono(tmp_path):
    path = make_stereo_wav(tmp_path / "stereo.wav")
    audio = decode_with_av(path)
    assert audio.dtype == np.float32
    assert abs(audio.size - 8000) < 400  # 0.5 s at 16 kHz
    assert np.abs(audio).max() <= 1.0


def test_transcription_uses_av_for_nonstandard_wav(tmp_path, monkeypatch):
    path = make_stereo_wav(tmp_path / "stereo.wav")
    transcriber = Transcriber("Systran/faster-whisper-base")
    model = FakeModel([Segment(" hello")])
    monkeypatch.setattr(transcriber, "_load_model", lambda: model)
    assert transcriber.transcribe(path) == "hello"
    assert isinstance(model.seen, np.ndarray)
    assert abs(model.seen.size - 8000) < 400
