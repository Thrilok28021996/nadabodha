import shutil
import threading
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
    transcriber = Transcriber("Systran/faster-whisper-base", backend="cpu")
    model = FakeModel([Segment(" hello "), Segment("world")])
    monkeypatch.setattr(transcriber, "_load_model", lambda: model)
    assert transcriber.transcribe(wav) == "hello world"
    # The model must receive decoded samples, never a path: faster-whisper's
    # own PyAV decoder is incompatible with current PyAV releases.
    assert isinstance(model.seen, np.ndarray)
    assert model.seen.dtype == np.float32


def test_empty_result_is_empty_string(tmp_path, monkeypatch):
    wav = make_wav(tmp_path / "audio.wav")
    transcriber = Transcriber("Systran/faster-whisper-base", backend="cpu")
    monkeypatch.setattr(transcriber, "_load_model", lambda: FakeModel([]))
    assert transcriber.transcribe(wav) == ""


def test_missing_audio_file_is_reported(tmp_path):
    transcriber = Transcriber("Systran/faster-whisper-base", backend="cpu")
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
    transcriber = Transcriber("Systran/faster-whisper-base", backend="cpu")
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
    transcriber = Transcriber("Systran/faster-whisper-base", backend="cpu")
    model = FakeModel([Segment(" hello")])
    monkeypatch.setattr(transcriber, "_load_model", lambda: model)
    assert transcriber.transcribe(path) == "hello"
    assert isinstance(model.seen, np.ndarray)
    assert abs(model.seen.size - 8000) < 400


class KwargModel:
    """Records the keyword arguments handed to ``transcribe``."""

    def __init__(self):
        self.kwargs = None

    def transcribe(self, audio, **kwargs):
        self.kwargs = kwargs
        return iter([Segment("ok")]), object()


def test_language_and_timestamps_reach_the_model(tmp_path, monkeypatch):
    wav = make_wav(tmp_path / "audio.wav")
    transcriber = Transcriber("Systran/faster-whisper-base", backend="cpu")
    model = KwargModel()
    monkeypatch.setattr(transcriber, "_load_model", lambda: model)

    transcriber.transcribe_result(wav, language="en", without_timestamps=True)
    assert model.kwargs["language"] == "en"
    assert model.kwargs["without_timestamps"] is True


def test_defaults_keep_auto_detection_and_timestamps(tmp_path, monkeypatch):
    wav = make_wav(tmp_path / "audio.wav")
    transcriber = Transcriber("Systran/faster-whisper-base", backend="cpu")
    model = KwargModel()
    monkeypatch.setattr(transcriber, "_load_model", lambda: model)

    transcriber.transcribe_result(wav)
    # empty string means "let Whisper detect it"; the app relies on this for
    # recordings, which may not be English.
    assert model.kwargs["language"] is None
    assert model.kwargs["without_timestamps"] is False


def test_preload_loads_the_model_once(monkeypatch):
    transcriber = Transcriber("Systran/faster-whisper-base", backend="cpu")
    calls = []
    monkeypatch.setattr(transcriber, "_load_model", lambda: calls.append(True) or object())
    transcriber.preload()
    assert calls == [True]


# -- backend selection -----------------------------------------------------


def test_cpu_backend_never_reports_mlx():
    from svara.transcriber import CT2_MODEL_FILE

    transcriber = Transcriber(backend="cpu")
    assert transcriber.use_mlx is False
    assert transcriber.active_repo == transcriber.model_repo
    assert transcriber.model_file == CT2_MODEL_FILE


def test_mlx_backend_uses_the_gpu_repo_and_weights_file():
    from svara.transcriber import MLX_MODEL_FILE

    transcriber = Transcriber(backend="mlx")
    assert transcriber.use_mlx is True
    assert transcriber.active_repo == transcriber.mlx_model_repo
    assert transcriber.active_repo.startswith("mlx-community/")
    assert transcriber.model_file == MLX_MODEL_FILE


def test_auto_backend_follows_mlx_availability(monkeypatch):
    from svara import transcriber as module

    monkeypatch.setattr(module, "mlx_available", lambda: False)
    assert Transcriber(backend="auto").use_mlx is False

    monkeypatch.setattr(module, "mlx_available", lambda: True)
    assert Transcriber(backend="auto").use_mlx is True


def test_model_cache_check_is_backend_aware(tmp_path):
    """A complete CT2 snapshot must not look like a complete MLX one."""
    from svara.transcriber import CT2_MODEL_FILE, MLX_MODEL_FILE, is_model_cached

    snapshot = tmp_path / "hub" / "models--org--name" / "snapshots" / "abc"
    snapshot.mkdir(parents=True)
    (snapshot / CT2_MODEL_FILE).write_bytes(b"\0" * 2_000_000)

    assert is_model_cached("org/name", str(tmp_path), CT2_MODEL_FILE) is True
    assert is_model_cached("org/name", str(tmp_path), MLX_MODEL_FILE) is False


def test_settings_reject_unknown_backend():
    from svara.settings import Settings

    assert Settings.from_dict({"stt_backend": "metal"}).stt_backend == "auto"
    assert Settings.from_dict({"stt_backend": "cpu"}).stt_backend == "cpu"
    assert Settings().stt_backend == "auto"


# -- MLX result parsing ----------------------------------------------------


class FakeMLX:
    """Stand-in for the mlx_whisper module, so the GPU path is testable."""

    def __init__(self, payload):
        self.payload = payload
        self.seen = None

    def transcribe(self, audio, **kwargs):
        self.seen = kwargs
        return self.payload


def test_mlx_result_is_parsed_into_segments(tmp_path, monkeypatch):
    import sys
    import types

    wav = make_wav(tmp_path / "audio.wav")
    fake = FakeMLX(
        {
            "text": "ignored",
            "segments": [
                {"start": 0.0, "end": 1.5, "text": " hello "},
                {"start": 1.5, "end": 2.0, "text": "   "},
                {"start": 2.0, "end": 3.25, "text": "world"},
            ],
        }
    )
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    transcriber = Transcriber(backend="mlx")
    monkeypatch.setattr(transcriber, "_load_mlx_model", lambda: object())
    monkeypatch.setattr(transcriber, "_mlx_model_path", lambda: "/tmp/fake-model")

    result = transcriber.transcribe_result(wav, language="en", without_timestamps=True, allow_gpu=True)

    assert result.text == "hello world"
    assert [(s.start, s.end) for s in result.segments] == [(0.0, 1.5), (2.0, 3.25)]
    assert fake.seen["without_timestamps"] is True
    assert fake.seen["language"] == "en"
    # The GPU must be handed a local path, never a repo id: a repo id makes
    # mlx_whisper download into the default HF home instead of stt_cache_dir.
    assert fake.seen["path_or_hf_repo"] == "/tmp/fake-model"


def test_mlx_is_never_used_when_the_call_forbids_gpu(tmp_path, monkeypatch):
    wav = make_wav(tmp_path / "audio.wav")
    transcriber = Transcriber(backend="mlx")
    called = []
    monkeypatch.setattr(transcriber, "_transcribe_mlx", lambda *a: called.append(True) or [])
    model = KwargModel()
    monkeypatch.setattr(transcriber, "_load_model", lambda: model)

    transcriber.transcribe_result(wav, allow_gpu=False)
    assert called == []
    # Recordings keep beam search and VAD, which mlx_whisper does not implement.
    assert model.kwargs["beam_size"] == 5
    assert model.kwargs["vad_filter"] is True


def test_auto_backend_avoids_a_second_download_for_existing_installs(tmp_path, monkeypatch):
    from svara import transcriber as module

    monkeypatch.setattr(module, "mlx_available", lambda: True)
    # CT2 weights present, MLX weights absent: this is every existing install.
    snapshot = tmp_path / "hub" / "models--deepdml--faster-whisper-large-v3-turbo-ct2" / "snapshots" / "x"
    snapshot.mkdir(parents=True)
    (snapshot / "model.bin").write_bytes(b"\0" * 2_000_000)

    transcriber = Transcriber(cache_dir=str(tmp_path), backend="auto")
    use_mlx, repo, filename = transcriber.plan()
    assert use_mlx is False
    assert filename == "model.bin"


# -- the one MLX thread ----------------------------------------------------


class RecordingMLX(FakeMLX):
    """Fake mlx_whisper that also records the thread it is called from."""

    def __init__(self, payload, idents: list[int]) -> None:
        super().__init__(payload)
        self.idents = idents

    def transcribe(self, audio, **kwargs):
        self.idents.append(threading.get_ident())
        return super().transcribe(audio, **kwargs)


def test_preload_and_mlx_transcription_share_one_thread(tmp_path, monkeypatch):
    """The model must be materialised and evaluated on the same thread.

    mlx_whisper caches the model process-globally and the compute state belongs
    to the thread that built it, so a preload on this thread followed by a
    transcription elsewhere is exactly the production failure
    ("There is no Stream(gpu, 1) in current thread").
    """
    import sys

    wav = make_wav(tmp_path / "audio.wav")
    run_idents: list[int] = []
    fake = RecordingMLX(
        {
            "text": "ignored",
            "segments": [{"start": 0.0, "end": 1.0, "text": "ok"}],
        },
        run_idents,
    )
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    transcriber = Transcriber(backend="mlx")
    monkeypatch.setattr(
        transcriber,
        "_load_mlx_model",
        lambda: run_idents.append(threading.get_ident()) or object(),
    )
    monkeypatch.setattr(transcriber, "_mlx_model_path", lambda: "/tmp/fake-model")

    test_thread_ident = threading.get_ident()
    transcriber.preload(True)  # phase A: preload from the test thread

    caller_ident: list[int] = []
    failure: list[BaseException] = []

    def transcribe_from_another_thread():  # phase B: a different thread
        caller_ident.append(threading.get_ident())
        try:
            transcriber.transcribe_result(wav, allow_gpu=True)
        except BaseException as error:  # noqa: BLE001 - asserted below
            failure.append(error)

    thread = threading.Thread(target=transcribe_from_another_thread)
    thread.start()
    thread.join(timeout=30)
    assert not thread.is_alive(), "transcription deadlocked"
    assert not failure, failure

    # preload load, in-transcribe load, and the transcribe call itself
    assert len(run_idents) == 3
    assert len(set(run_idents)) == 1, f"MLX ran on several threads: {run_idents}"
    mlx_ident = run_idents[0]
    assert mlx_ident != test_thread_ident
    assert mlx_ident != caller_ident[0]


def test_cpu_backend_starts_no_mlx_worker(tmp_path, monkeypatch):
    """The CPU path is untouched: beam-5 + VAD, and no MLX thread is started."""
    wav = make_wav(tmp_path / "audio.wav")
    monkeypatch.setattr(transcriber_module, "_mlx_executor", None)
    monkeypatch.setattr(transcriber_module, "_mlx_worker_ident", None)

    transcriber = Transcriber("Systran/faster-whisper-base", backend="cpu")
    model = KwargModel()
    monkeypatch.setattr(transcriber, "_load_model", lambda: model)

    transcriber.transcribe_result(wav)
    assert model.kwargs is not None
    assert model.kwargs["beam_size"] == 5
    assert model.kwargs["vad_filter"] is True
    assert transcriber_module._mlx_executor is None
