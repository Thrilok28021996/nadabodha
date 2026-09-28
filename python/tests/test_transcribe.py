import json
import os
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "nadabodha_transcribe.py"


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
