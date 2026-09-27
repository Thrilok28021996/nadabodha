#!/usr/bin/env python3
"""
Local transcription adapter for Nadabodha.

Runs in server mode (--server) and reads JSON commands from stdin, one per line.
Emits JSON events on stdout.

Implemented adapters, in order of preference:
  1. whisper (openai-whisper) - best quality, downloads model on first run
  2. whisper.cpp wrapper if a `whisper-cli` binary is on PATH
  3. Vosk if installed
  4. Mock fallback that returns a placeholder transcript (no network, no upload)

The mock fallback ensures the Electron scaffold can exercise IPC/state
end-to-end even when no model is installed.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path
from typing import Callable


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def convert_to_wav(input_path: str, output_wav: str) -> bool:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    cmd = [
        ffmpeg,
        "-y",
        "-i", input_path,
        "-ar", "16000",
        "-ac", "1",
        "-sample_fmt", "s16",
        output_wav,
    ]
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return True
    except subprocess.CalledProcessError:
        return False


def _normalize_audio(input_path: str) -> str | None:
    ext = Path(input_path).suffix.lower()
    if ext == ".wav":
        return input_path
    tmp = os.path.join(tempfile.gettempdir(), f"nadabodha-{os.getpid()}.wav")
    if convert_to_wav(input_path, tmp):
        return tmp
    return None


class BaseTranscriber:
    def __init__(self, on_event: Callable[[dict], None]) -> None:
        self.on_event = on_event
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    def transcribe(self, file_path: str) -> None:
        raise NotImplementedError


class MockTranscriber(BaseTranscriber):
    """Fallback transcriber used when no local model is available."""

    def transcribe(self, file_path: str) -> None:
        self.on_event({"status": "transcribing", "progress": 0})
        for progress in (25, 50, 75, 100):
            if self._cancelled:
                self.on_event({"status": "cancelled"})
                return
            time.sleep(0.05)
            self.on_event({"status": "transcribing", "progress": progress})
        duration = _estimate_duration(file_path)
        self.on_event({
            "status": "completed",
            "text": (
                f"[Mock transcript] Processed {Path(file_path).name} "
                f"(~{duration:.1f}s). Install openai-whisper, whisper.cpp, or Vosk "
                "for real local transcription."
            ),
        })


def _estimate_duration(file_path: str) -> float:
    try:
        with wave.open(file_path, "rb") as wf:
            frames = wf.getnframes()
            rate = wf.getframerate()
            return frames / float(rate) if rate else 0.0
    except Exception:
        return 0.0


class WhisperTranscriber(BaseTranscriber):
    def __init__(self, on_event: Callable[[dict], None], model: str = "base") -> None:
        super().__init__(on_event)
        self.model = model

    def transcribe(self, file_path: str) -> None:
        import whisper  # type: ignore

        self.on_event({"status": "transcribing", "progress": 10})
        try:
            model = whisper.load_model(self.model)
            self.on_event({"status": "transcribing", "progress": 40})
            result = model.transcribe(file_path, fp16=False, verbose=False)
            self.on_event({"status": "transcribing", "progress": 90})
            text = result.get("text", "").strip()
            self.on_event({"status": "completed", "text": text})
        except Exception as exc:
            self.on_event({"status": "error", "error": f"Whisper error: {exc}"})


class WhisperCppTranscriber(BaseTranscriber):
    def __init__(self, on_event: Callable[[dict], None], model_path: str | None = None) -> None:
        super().__init__(on_event)
        self.model_path = model_path

    def transcribe(self, file_path: str) -> None:
        binary = shutil.which("whisper-cli") or shutil.which("main")
        if not binary:
            self.on_event({"status": "error", "error": "whisper-cli not found on PATH"})
            return
        model = self.model_path or os.environ.get("WHISPER_MODEL")
        if not model:
            self.on_event({"status": "error", "error": "WHISPER_MODEL path not configured"})
            return
        cmd = [binary, "-m", model, "-f", file_path, "-np", "-nt"]
        self.on_event({"status": "transcribing", "progress": 30})
        try:
            proc = subprocess.run(
                cmd,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            text = proc.stdout.strip()
            self.on_event({"status": "transcribing", "progress": 90})
            self.on_event({"status": "completed", "text": text})
        except subprocess.CalledProcessError as exc:
            self.on_event({"status": "error", "error": f"whisper.cpp error: {exc.stderr}"})


class VoskTranscriber(BaseTranscriber):
    def __init__(self, on_event: Callable[[dict], None], model_path: str | None = None) -> None:
        super().__init__(on_event)
        self.model_path = model_path

    def transcribe(self, file_path: str) -> None:
        try:
            from vosk import Model, KaldiRecognizer  # type: ignore
        except Exception as exc:
            self.on_event({"status": "error", "error": f"Vosk not available: {exc}"})
            return
        model_dir = self.model_path or os.environ.get("VOSK_MODEL")
        if not model_dir or not Path(model_dir).is_dir():
            self.on_event({"status": "error", "error": "VOSK_MODEL path not configured"})
            return
        self.on_event({"status": "transcribing", "progress": 20})
        model = Model(model_dir)
        rec = KaldiRecognizer(model, 16000)
        rec.SetWords(False)
        self.on_event({"status": "transcribing", "progress": 40})
        transcripts: list[str] = []
        with wave.open(file_path, "rb") as wf:
            while True:
                if self._cancelled:
                    self.on_event({"status": "cancelled"})
                    return
                data = wf.readframes(4000)
                if len(data) == 0:
                    break
                if rec.AcceptWaveform(data):
                    part = json.loads(rec.Result())
                    transcripts.append(part.get("text", ""))
        final = json.loads(rec.FinalResult())
        transcripts.append(final.get("text", ""))
        self.on_event({"status": "transcribing", "progress": 90})
        self.on_event({"status": "completed", "text": " ".join(t.strip() for t in transcripts if t)})


def _choose_transcriber(on_event: Callable[[dict], None]) -> BaseTranscriber:
    if os.environ.get("NADABODHA_MOCK_TRANSCRIBE") == "1":
        return MockTranscriber(on_event)
    if shutil.which("whisper-cli") or shutil.which("main"):
        return WhisperCppTranscriber(on_event)
    try:
        import whisper  # noqa: F401
        return WhisperTranscriber(on_event)
    except Exception:
        pass
    try:
        import vosk  # noqa: F401
        return VoskTranscriber(on_event)
    except Exception:
        pass
    return MockTranscriber(on_event)


def _run_server() -> None:
    transcriber: BaseTranscriber | None = None

    def on_event(event: dict) -> None:
        emit(event)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            command = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"status": "error", "error": f"Invalid JSON: {exc}"})
            continue

        action = command.get("action")
        if action == "transcribe":
            file_path = command.get("file_path")
            if not file_path:
                emit({"status": "error", "error": "file_path is required"})
                continue
            if not Path(file_path).is_file():
                emit({"status": "error", "error": f"File not found: {file_path}"})
                continue
            wav_path = _normalize_audio(file_path)
            if not wav_path:
                emit({"status": "error", "error": "Could not normalize audio to WAV"})
                continue
            transcriber = _choose_transcriber(on_event)
            thread = threading.Thread(target=transcriber.transcribe, args=(wav_path,))
            thread.start()
        elif action == "cancel":
            if transcriber:
                transcriber.cancel()
            emit({"status": "cancelled"})
        elif action == "ping":
            emit({"status": "idle", "text": "pong"})
        else:
            emit({"status": "error", "error": f"Unknown action: {action}"})


def main() -> None:
    parser = argparse.ArgumentParser(description="Nadabodha local transcription adapter")
    parser.add_argument("--server", action="store_true", help="Run in JSON-lines server mode")
    args = parser.parse_args()

    if args.server:
        _run_server()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
