"""System-audio capture (the other side of calls) via a ScreenCaptureKit helper."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

SAMPLE_RATE = 16_000
CHANNELS = 1
HELPER_NAME = "svara-system-audio"


class SystemAudioError(RuntimeError):
    """System audio could not be captured."""


def helper_path() -> Path | None:
    """Locate the bundled ScreenCaptureKit helper, if present."""
    roots: list[Path] = []
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle:
        roots.append(Path(bundle))
    roots.append(Path(__file__).resolve().parent.parent)
    for root in roots:
        candidate = root / "assets" / "bin" / HELPER_NAME
        if candidate.is_file():
            return candidate
    return None


def available() -> bool:
    return sys.platform == "darwin" and helper_path() is not None


def mix_wavs(paths: list[Path], output: Path) -> Path:
    """Mix 16 kHz mono WAVs by summing samples; shorter tracks are zero-padded."""
    import numpy as np

    tracks = []
    for path in paths:
        with wave.open(str(path), "rb") as handle:
            if handle.getframerate() != SAMPLE_RATE or handle.getnchannels() != CHANNELS:
                raise SystemAudioError(f"Unexpected audio format in {path.name}")
            frames = handle.readframes(handle.getnframes())
        tracks.append(np.frombuffer(frames, dtype=np.int16).astype(np.int32))
    if not tracks:
        raise SystemAudioError("Nothing to mix")
    length = max(len(track) for track in tracks)
    mixed = np.zeros(length, dtype=np.int32)
    for track in tracks:
        mixed[: len(track)] += track
    clipped = np.clip(mixed, -32768, 32767).astype(np.int16)
    with wave.open(str(output), "wb") as handle:
        handle.setnchannels(CHANNELS)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(clipped.tobytes())
    return output


class SystemAudioRecorder:
    """Runs the helper process for one take and returns a 16 kHz mono WAV."""

    def __init__(self, helper: Path | None = None) -> None:
        self._helper = helper or helper_path()
        self._process: subprocess.Popen[str] | None = None
        self._temp_dir: Path | None = None
        self._path: Path | None = None
        self._errors: list[str] = []

    @property
    def recording(self) -> bool:
        return self._process is not None and self._process.poll() is None

    @property
    def path(self) -> Path | None:
        return self._path

    def _drain(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        for line in process.stderr:
            text = line.strip()
            if text:
                self._errors.append(text)
                del self._errors[:-20]

    def start(self) -> Path:
        if self._process is not None:
            raise SystemAudioError("System audio is already recording")
        if not available():
            raise SystemAudioError(
                "System audio capture is unavailable: the ScreenCaptureKit helper is missing."
            )
        assert self._helper is not None
        self._temp_dir = Path(tempfile.mkdtemp(prefix="svara-system-"))
        self._path = self._temp_dir / "system.wav"
        self._errors = []
        try:
            self._process = subprocess.Popen(
                [str(self._helper), str(self._path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
        except OSError as error:
            raise SystemAudioError(f"Could not start system audio capture: {error}") from error
        threading.Thread(target=self._drain, daemon=True).start()
        time.sleep(1.2)
        if self._process.poll() is not None:
            detail = " ".join(self._errors[-2:]) or "the helper exited"
            self._cleanup()
            raise SystemAudioError(self._explain(detail))
        return self._path

    @staticmethod
    def _explain(detail: str) -> str:
        if "screen capture access=false" in detail or "declined" in detail.lower() or "permission" in detail.lower():
            return (
                "System audio needs Screen Recording permission. Open System Settings → "
                "Privacy & Security → Screen Recording, enable Svara, then try again."
            )
        return f"System audio capture failed: {detail}"

    def stop(self) -> Path:
        process, self._process = self._process, None
        if process is None:
            raise SystemAudioError("System audio is not recording")
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        time.sleep(0.2)
        errors = " ".join(self._errors[-3:])
        if process.returncode not in (0, None) and not (self._path and self._path.stat().st_size > 44):
            self._cleanup()
            raise SystemAudioError(self._explain(errors or f"helper exited {process.returncode}"))
        if not self._path or not self._path.exists() or self._path.stat().st_size <= 44:
            self._cleanup()
            raise SystemAudioError(
                self._explain(errors or "no audio was captured — is anything playing?")
            )
        return self._path

    def _cleanup(self) -> None:
        if self._temp_dir and self._temp_dir.exists():
            shutil.rmtree(self._temp_dir, ignore_errors=True)
        self._temp_dir = None
        self._path = None

    def cleanup(self) -> None:
        self._cleanup()
