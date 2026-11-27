"""Microphone recording through PortAudio (``sounddevice``).

ffmpeg's avfoundation input on this macOS build delivers only a fraction of the
captured samples (an 8 s take produced ~2.2 s of audio), so capture goes
through PortAudio/CoreAudio instead, which records the full duration. ffmpeg is
still used by the transcriber for format conversion.

Takes are written to a private temporary directory and copied into the app's
recordings folder before transcription, so a later failure can never lose the
audio.
"""

from __future__ import annotations

import shutil
import tempfile
import threading
import time
import wave
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

MICROPHONE_DENIED_MESSAGE = (
    "Microphone access denied. Allow it in System Settings > Privacy & Security > "
    "Microphone, then try again."
)

SAMPLE_RATE = 16000
CHANNELS = 1
MIN_FREE_BYTES = 200 * 1024 * 1024


class RecorderError(RuntimeError):
    """Recording could not start, stop, or produced no usable audio."""


def _device_selector(device: str):
    """PortAudio wants an int index or a name; settings store indices as text."""
    selector = (device or "").strip()
    if not selector:
        return None
    return int(selector) if selector.isdigit() else selector


def _open_stream(samplerate: int, channels: int, callback, device: str = "") -> object:  # type: ignore[no-untyped-def]
    """Open and start a PortAudio input stream (monkeypatched in tests)."""
    try:
        import sounddevice as sd
    except ImportError as error:
        raise RecorderError(
            "Recording needs the sounddevice package. Run: pip install sounddevice"
        ) from error
    kwargs = {"samplerate": samplerate, "channels": channels, "dtype": "int16", "callback": callback}
    selector = _device_selector(device)
    if selector is not None:
        kwargs["device"] = selector
    stream = sd.InputStream(**kwargs)
    stream.start()
    return stream


def _permission_message(detail: str) -> str:
    lowered = detail.lower()
    if "permission" in lowered or "denied" in lowered or "not permitted" in lowered or "-9986" in lowered:
        return MICROPHONE_DENIED_MESSAGE
    return f"Could not start the microphone: {detail}"


class Recorder:
    """Captures one take and writes it as a 16 kHz mono WAV."""

    def __init__(self, sample_rate: int = SAMPLE_RATE, channels: int = CHANNELS, input_device: str = "") -> None:
        self._sample_rate = sample_rate
        self._channels = channels
        self._input_device = (input_device or "").strip()
        self._stream = None
        self._frames: list[np.ndarray] = []
        self._status = ""
        self._lock = threading.Lock()
        self._temp_dir: Path | None = None
        self._output: Path | None = None
        self._started_at: float | None = None
        self.last_rms = 0.0

    # -- state -------------------------------------------------------------

    @property
    def is_recording(self) -> bool:
        return self._stream is not None

    @property
    def started_at(self) -> float | None:
        return self._started_at

    def elapsed_seconds(self) -> float:
        if self._started_at is None:
            return 0.0
        return max(0.0, time.monotonic() - self._started_at)

    # -- capture -----------------------------------------------------------

    def start(self) -> Path:
        if self._stream is not None:
            raise RecorderError("Recording already in progress")
        self._temp_dir = Path(tempfile.mkdtemp(prefix="svara-"))
        self._output = self._temp_dir / f"recording-{int(time.time() * 1000)}.wav"
        self._frames = []
        self._status = ""
        try:
            free = shutil.disk_usage(self._temp_dir).free
        except OSError:
            free = 0
        if free and free < MIN_FREE_BYTES:
            self._cleanup_temp_dir()
            raise RecorderError(
                f"Not enough free disk space to record: {free / 1e6:.0f} MB available, need 200 MB."
            )

        def callback(indata, _frames, _time_info, status) -> None:  # noqa: ANN001 - PortAudio API
            if status:
                self._status = str(status)
            with self._lock:
                self._frames.append(indata.copy())

        try:
            self._stream = _open_stream(self._sample_rate, self._channels, callback, self._input_device)
        except RecorderError:
            self._cleanup_temp_dir()
            raise
        except Exception as error:  # noqa: BLE001 - PortAudio raises its own error type
            self._cleanup_temp_dir()
            raise RecorderError(_permission_message(str(error))) from error

        self._started_at = time.monotonic()
        return self._output

    def stop(self) -> Path:
        stream, self._stream = self._stream, None
        output = self._output
        if stream is None or output is None:
            raise RecorderError("Not recording")
        self._close_stream(stream)
        self._started_at = None

        with self._lock:
            frames = self._frames
            self._frames = []
        if not frames:
            detail = f" ({self._status})" if self._status else ""
            raise RecorderError(f"Recording failed: no audio was captured{detail}")
        samples = np.concatenate(frames, axis=0)
        if samples.size == 0:
            raise RecorderError("Recording failed: no audio was captured")
        floats = samples.astype(np.float32) / 32768.0
        self.last_rms = float(np.sqrt((floats.astype(np.float64) ** 2).mean()))
        self._write_wav(output, samples)
        return output

    def cancel(self) -> None:
        stream, self._stream = self._stream, None
        self._started_at = None
        if stream is not None:
            self._close_stream(stream)
        with self._lock:
            self._frames = []
        self._cleanup_temp_dir()
        self._output = None

    # -- internals ---------------------------------------------------------

    @staticmethod
    def _close_stream(stream) -> None:  # type: ignore[no-untyped-def]
        try:
            stream.stop()
        except Exception:  # noqa: BLE001 - already stopped
            pass
        try:
            stream.close()
        except Exception:  # noqa: BLE001 - already closed
            pass

    def _write_wav(self, path: Path, samples: np.ndarray) -> None:
        data = np.ascontiguousarray(samples, dtype=np.int16).tobytes()
        try:
            with wave.open(str(path), "wb") as handle:
                handle.setnchannels(self._channels)
                handle.setsampwidth(2)
                handle.setframerate(self._sample_rate)
                handle.writeframes(data)
        except OSError as error:
            raise RecorderError(f"Could not write the recording: {error}") from error
        if path.stat().st_size <= 44:
            raise RecorderError("Recording failed: the audio file is empty")

    def _cleanup_temp_dir(self) -> None:
        if self._temp_dir is not None and self._temp_dir.exists():
            shutil.rmtree(self._temp_dir, ignore_errors=True)
        self._temp_dir = None

    def cleanup_after_persist(self, recorded_path: Path) -> None:
        """Remove the temporary directory once the take has been copied out."""
        parent = Path(recorded_path).parent
        if self._temp_dir is not None and parent == self._temp_dir:
            shutil.rmtree(parent, ignore_errors=True)
            self._temp_dir = None

    def set_input_device(self, device: str) -> None:
        self._input_device = (device or "").strip()


def cleanup_stale_temp_dirs(max_age_hours: float = 24.0) -> int:
    """Remove abandoned ``svara-*`` take directories from previous crashes."""
    root = Path(tempfile.gettempdir())
    cutoff = time.time() - max_age_hours * 3600
    removed = 0
    try:
        candidates = list(root.glob("svara-*"))
    except OSError:
        return 0
    for path in candidates:
        try:
            if path.is_dir() and path.stat().st_mtime < cutoff:
                shutil.rmtree(path, ignore_errors=True)
                removed += 1
        except OSError:
            continue
    return removed


def persist_recording(source: Path, directory: Path, now: datetime | None = None) -> Path:
    """Copy a finished take into durable storage and return the new path."""
    source = Path(source)
    directory = Path(directory)
    if not source.is_file() or source.stat().st_size <= 0:
        raise RecorderError("Recording file is empty or unavailable")
    directory.mkdir(parents=True, exist_ok=True)
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H-%M-%S-%f")
    destination = directory / f"recording-{stamp}.wav"
    suffix = 1
    while destination.exists():
        destination = directory / f"recording-{stamp}-{suffix}.wav"
        suffix += 1
    shutil.copyfile(source, destination)
    if destination.stat().st_size <= 0:
        destination.unlink(missing_ok=True)
        raise RecorderError("Recording copy is empty")
    return destination
