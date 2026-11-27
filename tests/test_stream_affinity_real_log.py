"""Regression: the stream-affinity failure degrades into the REAL app log.

``test_stream_affinity_failure_is_logged_and_finished_on_the_cpu`` in
``test_transcriber.py`` replaces ``get_logger`` with an in-memory recorder, so
the production logging path (``AppLogger.log`` -> JSON lines -> ``svara.log``,
with the traceback attached) is never exercised. This test drives the forced
fallback end to end instead:

* fake ``mlx_whisper.transcribe`` raising MLX's thread-affinity error verbatim,
* the real ``Transcriber.transcribe_result`` GPU branch and its guard,
* the real CPU decode behind the fallback (``Systran/faster-whisper-base``,
  already cached locally, so no download),
* the real ``logging_setup`` writing an isolated ``svara.log`` under tmp_path.

It fails against pre-fix code (base ``be5ba11``): ``transcribe_result`` had no
guard there, so the ``TranscriptionError`` propagates out of the take and no
ERROR record is ever written.
"""

from __future__ import annotations

import json
import sys
import wave
from pathlib import Path

from svara import logging_setup
from svara.transcriber import Transcriber, TranscriptionResult

#: The production failure string, index included: MLX's process-global stream
#: counter made the number vary run to run in the wild.
PRODUCTION_ERROR = "There is no Stream(gpu, 1) in current thread."


def _write_wav(path: Path, seconds: float = 1.0) -> Path:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(b"\x00" * int(16000 * 2 * seconds))
    return path


class RaisingMLX:
    """Fake ``mlx_whisper`` raising exactly the way cross-thread MLX does."""

    def transcribe(self, audio, **kwargs):  # noqa: ANN001, ANN003 - mlx signature
        raise RuntimeError(PRODUCTION_ERROR)


def test_stream_affinity_failure_reaches_the_real_app_log(tmp_path, monkeypatch):
    wav = _write_wav(tmp_path / "audio.wav")
    log_file = tmp_path / "logs" / "svara.log"

    # Real AppLogger on an isolated file; the suite's logger is restored on
    # teardown (monkeypatch records the pre-test value before init replaces it).
    monkeypatch.setattr(logging_setup, "_logger", None)
    logging_setup.init_logging(path=log_file)

    monkeypatch.setitem(sys.modules, "mlx_whisper", RaisingMLX())

    transcriber = Transcriber("Systran/faster-whisper-base", backend="mlx")
    monkeypatch.setattr(transcriber, "_load_mlx_model", lambda: object())
    monkeypatch.setattr(transcriber, "_mlx_model_path", lambda: "/tmp/fake-model")

    # Keep the CPU decode real, but prove the fallback actually reached it.
    cpu_models: list[object] = []
    real_load_model = transcriber._load_model

    def spy_load_model():
        model = real_load_model()
        cpu_models.append(model)
        return model

    monkeypatch.setattr(transcriber, "_load_model", spy_load_model)

    # The take must complete on the CPU backend instead of raising.
    result = transcriber.transcribe_result(wav, allow_gpu=True)
    assert isinstance(result, TranscriptionResult)
    assert cpu_models, "the CPU fallback backend never ran"

    # ...and the real log file must carry the ERROR with its full context.
    lines = log_file.read_text(encoding="utf-8").splitlines()
    records = [json.loads(line) for line in lines if line.strip()]
    errors = [record for record in records if record.get("level") == "ERROR"]
    assert len(errors) == 1, errors

    record = errors[0]
    assert record["scope"] == "transcription"
    assert "another thread" in record["message"]
    details = record.get("details") or {}
    assert details.get("type") == "TranscriptionError"
    assert PRODUCTION_ERROR in str(details.get("message", ""))
    assert PRODUCTION_ERROR in str(details.get("traceback", ""))
