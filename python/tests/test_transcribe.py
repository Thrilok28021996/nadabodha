import json
import os
import subprocess
import sys
import tempfile
import threading
import time
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


# ---------------------------------------------------------------------------
# F1 - a download always ends with exactly one terminal event
# ---------------------------------------------------------------------------

REPO_ID = "org/sample-model"


def _terminals(events):
    return [e for e in events if e["status"] in adapter.DOWNLOAD_TERMINAL_STATUSES]


def _patch_snapshot_download(monkeypatch, fake):
    import huggingface_hub

    monkeypatch.setattr(huggingface_hub, "snapshot_download", fake)


def _join_active_worker(timeout: float = 10.0):
    """Let a test's stand-in worker finish and reset the module state."""
    worker = getattr(adapter, "_ACTIVE_DOWNLOAD_WORKER", None)
    if worker is not None and worker.is_alive():
        worker.join(timeout)
    setattr(adapter, "_ACTIVE_DOWNLOAD_WORKER", None)


def test_terminal_emitter_reports_once():
    seen = []
    emit = adapter.TerminalEmitter(seen.append)
    emit({"status": "downloading", "progress": 10})
    emit({"status": "cancelled"})
    emit({"status": "cancelled"})
    emit({"status": "error", "error": "late failure"})
    assert [event["status"] for event in seen] == ["downloading", "cancelled"]
    assert emit.sent is True


def test_download_cancel_is_reported_promptly_when_hub_ignores_abort(monkeypatch):
    """xet keeps transferring after the abort is swallowed: report anyway."""
    release = threading.Event()

    def ignores_abort(*args, **kwargs):
        # Stands in for hf_xet: the DownloadCancelled raised from the progress
        # callback never escapes, the transfer simply carries on.
        release.wait(10)
        raise adapter.DownloadCancelled()

    _patch_snapshot_download(monkeypatch, ignores_abort)
    events = []
    cancel = threading.Event()
    threading.Timer(0.2, cancel.set).start()
    with tempfile.TemporaryDirectory() as cache:
        monkeypatch.setenv("HF_HOME", cache)
        monkeypatch.setenv("HF_HUB_CACHE", cache)
        started = time.time()
        try:
            ok = adapter.download_model(REPO_ID, cache, events.append, cancel)
            elapsed = time.time() - started
        finally:
            release.set()
            _join_active_worker()

    assert ok is False
    assert elapsed < 2.0, f"terminal event arrived after {elapsed:.2f}s"
    terminals = _terminals(events)
    assert len(terminals) == 1, f"expected one terminal event, got {terminals}"
    assert terminals[0]["status"] == "cancelled"
    assert terminals[0]["origin"] == "download"
    assert all(e["origin"] == "download" for e in events)


def test_download_cancelled_before_start_is_terminal(monkeypatch):
    def slow(*args, **kwargs):
        time.sleep(3)
        return "/somewhere"

    _patch_snapshot_download(monkeypatch, slow)
    events = []
    cancel = threading.Event()
    cancel.set()
    with tempfile.TemporaryDirectory() as cache:
        monkeypatch.setenv("HF_HOME", cache)
        monkeypatch.setenv("HF_HUB_CACHE", cache)
        started = time.time()
        try:
            ok = adapter.download_model(REPO_ID, cache, events.append, cancel)
            elapsed = time.time() - started
        finally:
            _join_active_worker()

    assert ok is False
    assert elapsed < 2.0
    assert [e["status"] for e in _terminals(events)] == ["cancelled"]


def test_download_failure_reports_exactly_one_error(monkeypatch):
    def explodes(*args, **kwargs):
        raise RuntimeError("no space left")

    _patch_snapshot_download(monkeypatch, explodes)
    events = []
    with tempfile.TemporaryDirectory() as cache:
        monkeypatch.setenv("HF_HOME", cache)
        monkeypatch.setenv("HF_HUB_CACHE", cache)
        try:
            ok = adapter.download_model(REPO_ID, cache, events.append, threading.Event())
        finally:
            _join_active_worker()

    assert ok is False
    terminals = _terminals(events)
    assert len(terminals) == 1
    assert terminals[0]["status"] == "error"
    assert "no space left" in terminals[0]["error"]


def test_download_success_reports_exactly_one_completed(monkeypatch):
    def succeeds(*args, **kwargs):
        return "/cache/models--org--sample-model/snapshots/abc"

    _patch_snapshot_download(monkeypatch, succeeds)
    events = []
    with tempfile.TemporaryDirectory() as cache:
        monkeypatch.setenv("HF_HOME", cache)
        monkeypatch.setenv("HF_HUB_CACHE", cache)
        try:
            ok = adapter.download_model(REPO_ID, cache, events.append, threading.Event())
        finally:
            _join_active_worker()

    assert ok is True
    terminals = _terminals(events)
    assert len(terminals) == 1
    assert terminals[0]["status"] == "completed"
    assert terminals[0]["progress"] == 100


def test_download_worker_hard_failure_still_reports(monkeypatch):
    def interrupts(*args, **kwargs):
        raise KeyboardInterrupt()

    _patch_snapshot_download(monkeypatch, interrupts)
    events = []
    with tempfile.TemporaryDirectory() as cache:
        monkeypatch.setenv("HF_HOME", cache)
        monkeypatch.setenv("HF_HUB_CACHE", cache)
        try:
            ok = adapter.download_model(REPO_ID, cache, events.append, threading.Event())
        finally:
            _join_active_worker()

    assert ok is False
    assert len(_terminals(events)) == 1
    assert _terminals(events)[0]["status"] == "error"


def test_disabled_progress_bar_still_tracks_bytes():
    """snapshot_download's aggregate bar is disabled when stdout is a pipe;
    tqdm then skips assigning `unit`, which used to zero the byte counters."""
    events = []
    reporter = adapter.ProgressReporter(events.append, REPO_ID, threading.Event())
    bar_cls = adapter._make_progress_tqdm(reporter)
    bar = bar_cls(desc="Downloading", total=4096, initial=0, unit="B", disable=True, name="probe")

    assert getattr(bar, "unit", None) == "B"
    bar.update(1024)
    assert reporter.bytes_done == 1024
    assert reporter.bytes_total == 4096
    assert reporter.percent() == 25


def test_progress_reports_bytes_and_never_moves_backwards():
    events = []

    class Bar:
        def __init__(self, unit, n, total):
            self.unit = unit
            self.n = n
            self.total = total

    reporter = adapter.ProgressReporter(events.append, REPO_ID, threading.Event())
    reporter.maybe_emit(force=True)
    assert [e["progress"] for e in events] == [0]

    # File counter drives the percentage while the byte total is unknown.
    reporter.last_emit = 0.0
    reporter.record(Bar("it", 2, 6))
    assert [e["progress"] for e in events] == [0, 33]

    # The aggregate byte total appears with almost nothing done: the bar must
    # not jump back to 0/1%, it keeps climbing.
    reporter.last_emit = 0.0
    reporter.record(Bar("B", 10, 1000))
    assert [e["progress"] for e in events] == [0, 33]

    reporter.last_emit = 0.0
    reporter.record(Bar("B", 500, 1000))
    assert [e["progress"] for e in events] == [0, 33, 50]
    assert events[-1]["bytes_done"] == 500
    assert events[-1]["bytes_total"] == 1000


# ---------------------------------------------------------------------------
# F2 - only loadable snapshots count as installed
# ---------------------------------------------------------------------------


def _make_repo_cache(base: Path) -> tuple[Path, Path]:
    repo_dir = base / ("models--" + REPO_ID.replace("/", "--"))
    revision = repo_dir / "snapshots" / "abc123"
    revision.mkdir(parents=True)
    (revision / "config.json").write_text('{"model_type": "whisper"}')
    (revision / "model.bin").write_bytes(b"weights")
    refs = repo_dir / "refs"
    refs.mkdir(parents=True, exist_ok=True)
    (refs / "main").write_text("abc123")
    return repo_dir, revision


def test_snapshot_complete_requires_loadable_files():
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        assert adapter._snapshot_complete(REPO_ID, tmp) is False

        repo_dir, revision = _make_repo_cache(base)
        assert adapter._snapshot_complete(REPO_ID, tmp) is True
        assert adapter._snapshot_complete(REPO_ID, "") is False

        # Missing config -> transformers/faster-whisper cannot load it.
        (revision / "config.json").unlink()
        assert adapter._snapshot_complete(REPO_ID, tmp) is False
        (revision / "config.json").write_text('{"model_type": "whisper"}')

        # Truncated weights.
        (revision / "model.bin").write_bytes(b"")
        assert adapter._snapshot_complete(REPO_ID, tmp) is False
        (revision / "model.bin").write_bytes(b"weights")

        # Weights without a config are not loadable either.
        (revision / "model.bin").unlink()
        assert adapter._snapshot_complete(REPO_ID, tmp) is False
        (revision / "model.bin").write_bytes(b"weights")

        # Dangling symlink: the blob never landed.
        (revision / "model.bin").unlink()
        (revision / "model.bin").symlink_to(repo_dir / "blobs" / "does-not-exist")
        assert adapter._snapshot_complete(REPO_ID, tmp) is False
        (revision / "model.bin").unlink()
        (revision / "model.bin").write_bytes(b"weights")

        # Interrupted transfer marker left behind by a cancelled download.
        blobs = repo_dir / "blobs"
        blobs.mkdir(parents=True, exist_ok=True)
        (blobs / "model.bin.incomplete").write_bytes(b"partial")
        assert adapter._snapshot_complete(REPO_ID, tmp) is False
        (blobs / "model.bin.incomplete").unlink()

        # refs must resolve to a revision that exists on disk.
        (repo_dir / "refs" / "main").write_text("missing-revision")
        assert adapter._snapshot_complete(REPO_ID, tmp) is False
        (repo_dir / "refs" / "main").write_text("abc123")
        assert adapter._snapshot_complete(REPO_ID, tmp) is True


def test_snapshot_complete_checks_sharded_weights():
    with tempfile.TemporaryDirectory() as tmp:
        repo_dir, revision = _make_repo_cache(base=Path(tmp))
        (revision / "model.bin").unlink()
        shard_a = revision / "model-00001-of-00002.safetensors"
        shard_a.write_bytes(b"a" * 16)
        (revision / "model.safetensors.index.json").write_text(
            json.dumps(
                {
                    "metadata": {"total_size": 32},
                    "weight_map": {
                        "layer.0": "model-00001-of-00002.safetensors",
                        "layer.1": "model-00002-of-00002.safetensors",
                    },
                }
            )
        )
        # The second shard never arrived.
        assert adapter._snapshot_complete(REPO_ID, tmp) is False
        (revision / "model-00002-of-00002.safetensors").write_bytes(b"b" * 16)
        assert adapter._snapshot_complete(REPO_ID, tmp) is True


def test_ensure_model_retries_partial_snapshot(monkeypatch):
    """A partial snapshot triggers a re-download and never loads silently."""
    with tempfile.TemporaryDirectory() as tmp:
        _, revision = _make_repo_cache(base=Path(tmp))
        (revision / "config.json").unlink()  # incomplete: cancelled download

        calls = []
        events = []

        def fake_download(repo_id, cache_dir, on_event, cancel_event):
            calls.append(repo_id)
            return False  # cancelled again

        monkeypatch.setattr(adapter, "download_model", fake_download)
        transcriber = adapter.FasterWhisperTranscriber(events.append, REPO_ID, tmp)
        assert transcriber._ensure_model(REPO_ID, tmp) is False
        assert calls == [REPO_ID]
        assert events[0]["status"] == "downloading"
        # Download events do not drive the transcription state machine, so a
        # terminal transcription event has to follow them.
        assert events[-1]["status"] == "error"
        assert "incomplete" in events[-1]["error"] or "downloaded" in events[-1]["error"]

        # Once the snapshot is complete no download is attempted.
        (revision / "config.json").write_text('{"model_type": "whisper"}')
        events.clear()
        assert transcriber._ensure_model(REPO_ID, tmp) is True
        assert calls == [REPO_ID]
        assert events == []


# ---------------------------------------------------------------------------
# F3 - cache_dir must reach from_pretrained, never generate()
# ---------------------------------------------------------------------------


def test_build_asr_pipeline_keeps_cache_dir_out_of_generate_kwargs():
    captured = {}

    def fake_pipeline(task, **kwargs):
        captured["task"] = task
        captured.update(kwargs)
        return {"text": ""}

    adapter.build_asr_pipeline("openai/whisper-tiny", "/data/hf", pipeline_fn=fake_pipeline)
    assert captured["task"] == "automatic-speech-recognition"
    assert captured["model"] == "openai/whisper-tiny"
    assert captured["model_kwargs"] == {"cache_dir": "/data/hf"}
    assert "cache_dir" not in captured  # never a bare pipeline kwarg

    captured.clear()
    adapter.build_asr_pipeline("openai/whisper-tiny", "", pipeline_fn=fake_pipeline)
    assert "model_kwargs" not in captured


def test_cache_dir_kwarg_is_consumed_by_pipeline_not_generate():
    transformers = pytest.importorskip("transformers")
    inspect = pytest.importorskip("inspect")
    pipeline_module = pytest.importorskip("transformers.pipelines")

    # `model_kwargs` is a named pipeline() parameter, so it is consumed while
    # building the model/processor and never forwarded to the instance ...
    assert "model_kwargs" in inspect.signature(transformers.pipeline).parameters

    # ... whereas a bare cache_dir ends up in the generate() kwargs, which is
    # exactly the failure transformers rejects with "model_kwargs are not used
    # by the model: [cache_dir]".
    cls = pipeline_module.AutomaticSpeechRecognitionPipeline
    dummy = cls.__new__(cls)
    _, forward_params, _ = cls._sanitize_parameters(dummy, cache_dir="/data/hf")
    assert "cache_dir" in forward_params
