import json
import os
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "nadabodha_transcribe.py"


def _load_module():
    """Import the adapter module directly (no side effects: main() is guarded)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("nadabodha_transcribe", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


adapter = _load_module()


def _make_wav(path: str, duration_seconds: float = 0.1) -> None:
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        frames = int(16000 * duration_seconds)
        wf.writeframes(b"\x00" * (frames * 2))


def _send(proc, obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def _read_event(proc, timeout=10):
    line = proc.stdout.readline()
    if not line:
        raise RuntimeError("Adapter closed stdout unexpectedly")
    return json.loads(line)


def _server_proc(env=None):
    return subprocess.Popen(
        [sys.executable, str(SCRIPT), "--server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )


def _close(proc):
    if proc.stdin:
        proc.stdin.close()
    proc.wait(timeout=10)


def test_pong():
    proc = _server_proc()
    try:
        _send(proc, {"action": "ping"})
        event = _read_event(proc)
        assert event.get("text") == "pong"
    finally:
        _close(proc)


def test_mock_transcribe_completes():
    env = os.environ.copy()
    env["NADABODHA_MOCK_TRANSCRIBE"] = "1"
    proc = _server_proc(env=env)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            wav = os.path.join(tmp, "test.wav")
            _make_wav(wav)
            _send(proc, {"action": "transcribe", "file_path": wav})
            events = []
            deadline = 0
            while deadline < 20:
                event = _read_event(proc)
                events.append(event)
                if event["status"] in ("completed", "error"):
                    break
                deadline += 1
            statuses = {e["status"] for e in events}
            assert "completed" in statuses
            completed = next(e for e in events if e["status"] == "completed")
            assert "Mock transcript" in completed["text"]
    finally:
        _close(proc)


def test_cancel_mock_transcribe():
    env = os.environ.copy()
    env["NADABODHA_MOCK_TRANSCRIBE"] = "1"
    proc = _server_proc(env=env)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            wav = os.path.join(tmp, "test.wav")
            _make_wav(wav, duration_seconds=2.0)
            _send(proc, {"action": "transcribe", "file_path": wav})
            _send(proc, {"action": "cancel"})
            events = []
            deadline = 0
            while deadline < 20:
                line = proc.stdout.readline()
                if not line:
                    break
                event = json.loads(line)
                events.append(event)
                if event["status"] in ("cancelled", "completed", "error"):
                    break
                deadline += 1
            statuses = {e["status"] for e in events}
            assert "cancelled" in statuses
    finally:
        _close(proc)


def test_missing_file_error():
    proc = _server_proc()
    try:
        _send(proc, {"action": "transcribe", "file_path": "/does/not/exist.wav"})
        event = _read_event(proc)
        assert event["status"] == "error"
    finally:
        _close(proc)


# ---------------------------------------------------------------------------
# Hugging Face repo classification
# ---------------------------------------------------------------------------

def test_classify_ctranslate2_repo():
    kind, reason = adapter.classify_repo(
        "Systran/faster-whisper-base", tags=["ctranslate2", "automatic-speech-recognition"]
    )
    assert kind == "ctranslate2"
    assert reason is None
    # id-only classification (used by the download guard) must agree
    assert adapter.classify_repo("Systran/faster-whisper-large-v3")[0] == "ctranslate2"


def test_classify_pytorch_repo():
    kind, reason = adapter.classify_repo(
        "openai/whisper-tiny", tags=["pytorch", "automatic-speech-recognition"]
    )
    assert kind == "pytorch"
    assert reason is None
    assert adapter.classify_repo("openai/whisper-base")[0] == "pytorch"


def test_classify_unsupported_ggml_repo():
    kind, reason = adapter.classify_repo("ggerganov/whisper.cpp")
    assert kind == "unsupported"
    assert "ggml" in reason or "whisper.cpp" in reason


def test_classify_unsupported_ggml_by_file():
    kind, reason = adapter.classify_repo(
        "someone/whisper-model", files=["ggml-base.bin", "tokenizer.json"]
    )
    assert kind == "unsupported"
    assert "ggml" in reason


def test_classify_unsupported_pyannote_repo():
    kind, reason = adapter.classify_repo("pyannote/pyannote-activity-detection")
    assert kind == "unsupported"
    assert "diarization" in reason


def test_classify_unsupported_whisperkit_repo():
    kind, reason = adapter.classify_repo("argmaxinc/whisperkit-coreml")
    assert kind == "unsupported"
    assert "CoreML" in reason or "WhisperKit" in reason


def test_classify_unsupported_mlx_repo():
    kind, reason = adapter.classify_repo("mlx-community/whisper-large-v3-turbo")
    assert kind == "unsupported"
    assert "MLX" in reason


def test_classify_unsupported_non_asr_repo():
    kind, reason = adapter.classify_repo("sentence-transformers/all-MiniLM-L6-v2")
    assert kind == "unsupported"
    assert "speech" in reason


# ---------------------------------------------------------------------------
# Forced unsupported selections must fail with an error event (no network)
# ---------------------------------------------------------------------------

def test_forced_unsupported_model_repo_errors():
    proc = _server_proc()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            wav = os.path.join(tmp, "test.wav")
            _make_wav(wav)
            _send(proc, {
                "action": "transcribe",
                "file_path": wav,
                "model_repo": "pyannote/pyannote-activity-detection",
                "cache_dir": tmp,
            })
            event = _read_event(proc)
            assert event["status"] == "error"
            assert "cannot run locally" in event["error"]
    finally:
        _close(proc)


def test_download_unsupported_repo_errors_without_network():
    proc = _server_proc()
    try:
        _send(proc, {
            "action": "download_model",
            "repo_id": "ggerganov/whisper.cpp",
            "cache_dir": "/tmp/nadabodha-test-cache",
        })
        event = _read_event(proc)
        assert event["status"] == "error"
        assert event["origin"] == "download"
        assert "cannot run locally" in event["error"]
    finally:
        _close(proc)


def test_download_requires_repo_id():
    proc = _server_proc()
    try:
        _send(proc, {"action": "download_model", "cache_dir": ""})
        event = _read_event(proc)
        assert event["status"] == "error"
    finally:
        _close(proc)


# ---------------------------------------------------------------------------
# Cache directory handling
# ---------------------------------------------------------------------------

def test_apply_cache_dir_sets_hf_env(monkeypatch):
    monkeypatch.setenv("HF_HOME", "/original-hf-home")
    monkeypatch.setenv("HF_HUB_CACHE", "/original-hf-cache")
    adapter.apply_cache_dir("/data/custom-cache")
    assert os.environ["HF_HOME"] == "/data/custom-cache"
    assert os.environ["HF_HUB_CACHE"] == "/data/custom-cache"
    # empty value is a no-op
    adapter.apply_cache_dir("")
    assert os.environ["HF_HOME"] == "/data/custom-cache"


def test_snapshot_present_layout():
    with tempfile.TemporaryDirectory() as tmp:
        assert adapter._snapshot_present("Systran/faster-whisper-base", tmp) is False
        snap = Path(tmp) / "models--Systran--faster-whisper-base" / "snapshots" / "abc123"
        snap.mkdir(parents=True)
        assert adapter._snapshot_present("Systran/faster-whisper-base", tmp) is False
        (snap / "model.bin").write_bytes(b"x")
        assert adapter._snapshot_present("Systran/faster-whisper-base", tmp) is True
        assert adapter._snapshot_present("Systran/faster-whisper-base", "") is False
