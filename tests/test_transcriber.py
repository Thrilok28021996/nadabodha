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


# -- graceful degradation when the stream affinity error still escapes -----


class RaisingMLX(FakeMLX):
    """Fake mlx_whisper whose ``transcribe`` raises the way MLX does cross-thread."""

    def __init__(self, error: BaseException) -> None:
        super().__init__({})
        self.error = error

    def transcribe(self, audio, **kwargs):
        raise self.error


class RecordingLogger:
    """Stand-in for ``logging_setup.get_logger`` that keeps the records."""

    def __init__(self) -> None:
        self.records: list[tuple[str, str, object]] = []

    def error(self, scope, message, error=None) -> None:
        self.records.append((scope, message, error))


def test_stream_affinity_error_is_detected_through_the_wrapper_chain():
    from svara.transcriber import _is_mlx_stream_affinity_error

    # The index is MLX's process-global stream counter and varies run to run.
    for index in (0, 1, 7):
        cause = RuntimeError(f"There is no Stream(gpu, {index}) in current thread.")
        # ...wrapped the way _transcribe_mlx does: ``raise ... from error``.
        wrapped = TranscriptionError(f"Transcription failed: {cause}")
        wrapped.__cause__ = cause
        assert _is_mlx_stream_affinity_error(wrapped) is True
        assert _is_mlx_stream_affinity_error(cause) is True

    # Anything else keeps the old behaviour: no degradation.
    assert _is_mlx_stream_affinity_error(TranscriptionError("Transcription failed: boom")) is False
    assert _is_mlx_stream_affinity_error(RuntimeError("Metal device is out of memory")) is False


def test_stream_affinity_failure_is_logged_and_finished_on_the_cpu(tmp_path, monkeypatch):
    """The identified failure must degrade, not reach the logger as a hard fail.

    mlx_whisper raises MLX's thread-affinity RuntimeError inside
    ``_transcribe_mlx``; the take must still produce text (via the CPU
    backend) and the full error must land in the app log.
    """
    import sys

    wav = make_wav(tmp_path / "audio.wav")
    fake = RaisingMLX(RuntimeError("There is no Stream(gpu, 1) in current thread."))
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    logger = RecordingLogger()
    monkeypatch.setattr(transcriber_module, "get_logger", lambda: logger)

    transcriber = Transcriber(backend="mlx")
    monkeypatch.setattr(transcriber, "_load_mlx_model", lambda: object())
    monkeypatch.setattr(transcriber, "_mlx_model_path", lambda: "/tmp/fake-model")
    cpu_model = FakeModel([Segment(" cpu fallback ")])
    monkeypatch.setattr(transcriber, "_load_model", lambda: cpu_model)

    result = transcriber.transcribe_result(wav, allow_gpu=True)

    # The take completed instead of failing.
    assert result.text == "cpu fallback"
    assert cpu_model.seen is not None, "the CPU backend never ran"
    # ...and the error was logged with its full context.
    assert len(logger.records) == 1, logger.records
    scope, message, error = logger.records[0]
    assert scope == "transcription"
    assert "another thread" in message
    assert "There is no Stream(gpu, 1) in current thread" in str(error)


def test_unrelated_gpu_errors_still_propagate(tmp_path, monkeypatch):
    """Only the identified failure degrades; everything else still raises."""
    import sys

    wav = make_wav(tmp_path / "audio.wav")
    fake = RaisingMLX(RuntimeError("Metal device is out of memory"))
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    logger = RecordingLogger()
    monkeypatch.setattr(transcriber_module, "get_logger", lambda: logger)

    transcriber = Transcriber(backend="mlx")
    monkeypatch.setattr(transcriber, "_load_mlx_model", lambda: object())
    monkeypatch.setattr(transcriber, "_mlx_model_path", lambda: "/tmp/fake-model")
    cpu_calls: list[bool] = []
    monkeypatch.setattr(transcriber, "_load_model", lambda: cpu_calls.append(True) or FakeModel([]))

    with pytest.raises(TranscriptionError) as captured:
        transcriber.transcribe_result(wav, allow_gpu=True)

    assert "Metal device is out of memory" in str(captured.value)
    assert logger.records == [], "unrelated errors must not be swallowed"
    assert cpu_calls == [], "unrelated errors must not trigger a silent fallback"


def test_stream_error_reached_only_through_context_does_not_degrade(
    tmp_path, monkeypatch
):
    """A1: ``__context__`` alone must never be mistaken for the affinity failure.

    An unrelated GPU failure raised *while* a stream error was being handled
    carries that stream error in ``__context__``. Classifying it as the
    affinity failure would finish the take silently on the CPU and hide the
    real error; it must propagate instead.
    """
    import sys

    wav = make_wav(tmp_path / "audio.wav")

    class ContextRaisingMLX(FakeMLX):
        """Fake mlx_whisper raising an unrelated error under a stream error."""

        def __init__(self) -> None:
            super().__init__({})

        def transcribe(self, audio, **kwargs):
            try:
                raise RuntimeError("There is no Stream(gpu, 1) in current thread.")
            except RuntimeError:
                # Raising inside the handler sets __context__ to the stream
                # error, exactly as a second failure during handling would.
                raise RuntimeError("Metal device is out of memory")

    monkeypatch.setitem(sys.modules, "mlx_whisper", ContextRaisingMLX())
    logger = RecordingLogger()
    monkeypatch.setattr(transcriber_module, "get_logger", lambda: logger)

    transcriber = Transcriber(backend="mlx")
    monkeypatch.setattr(transcriber, "_load_mlx_model", lambda: object())
    monkeypatch.setattr(transcriber, "_mlx_model_path", lambda: "/tmp/fake-model")
    cpu_calls: list[bool] = []
    monkeypatch.setattr(
        transcriber, "_load_model", lambda: cpu_calls.append(True) or FakeModel([])
    )

    with pytest.raises(TranscriptionError) as captured:
        transcriber.transcribe_result(wav, allow_gpu=True)

    assert "Metal device is out of memory" in str(captured.value)
    assert logger.records == [], "a __context__-only stream error must not degrade"
    assert cpu_calls == [], "the take must not silently fall back to the CPU"


# -- the probe's confinement check -----------------------------------------


def _load_probe_module():
    """Import ``scripts/probe_mlx_preload_threads.py`` by path."""
    import importlib.util

    path = (
        Path(__file__).resolve().parent.parent
        / "scripts"
        / "probe_mlx_preload_threads.py"
    )
    spec = importlib.util.spec_from_file_location("probe_mlx_preload_threads", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_probe_helper_reports_the_worker_ident_not_the_caller(monkeypatch):
    """The probe must report ``_mlx_worker_ident``, never its own caller thread.

    Before B1 the probe printed ``run_in_fresh_thread``'s caller ident, which
    macOS recycles, so two different callers looked like one shared worker and
    a silent CPU fallback still exited 0.
    """
    probe = _load_probe_module()
    stub_worker = 987_654_321  # fixed, so threading.get_ident() can never match
    monkeypatch.setattr(transcriber_module, "_mlx_worker_ident", stub_worker)
    caller_ident = threading.get_ident()

    worker_ident = probe.read_mlx_worker_ident()
    assert worker_ident == stub_worker
    assert worker_ident != caller_ident

    takes = [("B", caller_ident, worker_ident), ("C", caller_ident, worker_ident)]
    assert probe.check_confinement(takes, []) == (stub_worker, 0, None)

    # The caller's own ident in the worker slot is exactly bug B1.
    wrong = [("B", caller_ident, caller_ident), ("C", caller_ident, caller_ident)]
    _worker, _degraded, failure = probe.check_confinement(wrong, [])
    assert failure is not None
    assert "caller thread" in failure

    # The guard firing during a take fails the check even with clean idents.
    guard = [
        (
            "transcription",
            "GPU transcription hit a stream owned by another thread; "
            "finishing this take on the CPU backend",
        )
    ]
    worker, degraded, failure = probe.check_confinement(takes, guard)
    assert (worker, degraded) == (stub_worker, 1)
    assert failure is not None

    # A worker that never ran (the base commit) fails too, and the reader
    # degrades to None rather than raising against base's module.
    monkeypatch.delattr(transcriber_module, "_mlx_worker_ident")
    assert probe.read_mlx_worker_ident() is None
    _worker, _degraded, failure = probe.check_confinement(
        [("B", caller_ident, None), ("C", caller_ident, None)], []
    )
    assert failure is not None

