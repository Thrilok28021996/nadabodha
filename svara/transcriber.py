"""Local speech-to-text through faster-whisper.

The model is loaded lazily on the first transcription so app startup stays
instant and an unconfigured model never blocks the UI. Loading and inference
are CPU-heavy; the UI runs ``transcribe`` on a worker thread.

Audio is decoded by ffmpeg into 16 kHz mono PCM and read with the standard
library, then handed to faster-whisper as a float32 NumPy array. Passing an
array (instead of a path) keeps the app independent of PyAV's API — recent
PyAV releases removed the ``metadata_errors`` keyword that faster-whisper's
own decoder passes to ``av.open``, which otherwise fails every transcription
with ``open() got an unexpected keyword argument 'metadata_errors'``.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import threading
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .models import DEFAULT_MODEL_REPO


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    text: str


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    segments: list[Segment]


class TranscriptionError(RuntimeError):
    """Transcription could not run or produced no text."""


def _is_standard_wav(path: Path) -> bool:
    """True when ``path`` is already 16 kHz mono 16-bit PCM."""
    try:
        with wave.open(str(path), "rb") as handle:
            return (
                handle.getframerate() == 16000
                and handle.getnchannels() == 1
                and handle.getsampwidth() == 2
                and handle.getcomptype() == "NONE"
            )
    except (wave.Error, EOFError, OSError):
        return False


def normalize_audio(input_path: Path, ffmpeg_path: str = "ffmpeg") -> Path:
    """Return a 16 kHz mono PCM WAV path for ``input_path``.

    A wave file that is already in the expected format is returned untouched;
    anything else is translated by ffmpeg into a temporary file that the caller
    deletes after use.
    """
    input_path = Path(input_path)
    if input_path.suffix.lower() == ".wav" and _is_standard_wav(input_path):
        return input_path
    ffmpeg = shutil.which(ffmpeg_path) or ffmpeg_path
    descriptor, temporary_name = tempfile.mkstemp(prefix="svara-convert-", suffix=".wav")
    os.close(descriptor)
    temporary = Path(temporary_name)
    args = [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", str(input_path),
        "-ar", "16000",
        "-ac", "1",
        "-sample_fmt", "s16",
        temporary,
    ]
    try:
        completed = subprocess.run(args, capture_output=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as error:
        temporary.unlink(missing_ok=True)
        raise TranscriptionError(f"Could not convert audio: {error}") from error
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip()
        temporary.unlink(missing_ok=True)
        raise TranscriptionError(f"Could not convert audio: {detail or 'ffmpeg failed'}")
    return temporary


def load_wav_float32(path: Path) -> np.ndarray:
    """Read a 16 kHz mono 16-bit PCM WAV into normalised float32 samples."""
    try:
        with wave.open(str(path), "rb") as handle:
            frames = handle.readframes(handle.getnframes())
    except (wave.Error, EOFError) as error:
        raise TranscriptionError(f"Could not read audio: {error}") from error
    samples = np.frombuffer(frames, dtype=np.int16)
    if samples.size == 0:
        raise TranscriptionError("Audio file contains no samples")
    return samples.astype(np.float32) / 32768.0


def decode_with_av(path: Path) -> np.ndarray:
    """Decode any audio file PyAV understands into 16 kHz mono float32.

    This is the bundle-safe path: PyAV ships with faster-whisper, so importing
    MP3/M4A works from the .app even when no system ffmpeg is on PATH.
    """
    try:
        import av
    except ImportError as error:  # pragma: no cover - PyAV is a faster-whisper dep
        raise TranscriptionError("Audio decoding needs PyAV (pip install av)") from error
    chunks: list[np.ndarray] = []
    try:
        with av.open(str(path)) as container:
            if not container.streams.audio:
                raise TranscriptionError(f"No audio stream in {Path(path).name}")
            stream = container.streams.audio[0]
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
            for frame in container.decode(stream):
                for resampled in resampler.resample(frame):
                    chunks.append(resampled.to_ndarray().reshape(-1))
            for resampled in resampler.resample(None):
                chunks.append(resampled.to_ndarray().reshape(-1))
    except TranscriptionError:
        raise
    except Exception as error:  # noqa: BLE001 - surfaced to the UI
        raise TranscriptionError(f"Could not decode audio: {error}") from error
    if not chunks:
        raise TranscriptionError("Audio file contains no samples")
    samples = np.concatenate(chunks)
    if samples.size == 0:
        raise TranscriptionError("Audio file contains no samples")
    if samples.dtype != np.int16:
        samples = samples.astype(np.int16)
    return samples.astype(np.float32) / 32768.0


def hub_cache_dir(cache_dir: str) -> str | None:
    """Translate a configured cache directory into an HF hub cache path.

    Settings store the Hugging Face *home* (e.g. ``/Volumes/personal/huggingface``
    or ``~/.cache/huggingface``), matching how ``HF_HOME`` is set in a shell.
    faster-whisper's ``download_root`` is the hub cache itself, so ``/hub`` is
    appended unless the caller already pointed at it.
    """
    configured = (cache_dir or "").strip()
    if not configured:
        return None
    root = Path(configured).expanduser()
    if root.name == "hub":
        return str(root)
    return str(root / "hub")


def repo_cache_dir(repo: str, cache_dir: str) -> Path:
    """Directory huggingface_hub uses for one repo (``models--org--name``)."""
    hub = hub_cache_dir(cache_dir) or str(Path.home() / ".cache" / "huggingface" / "hub")
    return Path(hub) / ("models--" + (repo or "").replace("/", "--"))


def is_model_cached(repo: str, cache_dir: str) -> bool:
    root = repo_cache_dir(repo, cache_dir)
    snapshots = root / "snapshots"
    if not snapshots.is_dir():
        return False
    for snapshot in snapshots.iterdir():
        model = snapshot / "model.bin"
        try:
            if model.is_file() and model.stat().st_size > 1_000_000:
                return True
        except OSError:
            continue
    return False


def cache_bytes(repo: str, cache_dir: str) -> int:
    """Bytes currently stored for the repo, including partial downloads."""
    root = repo_cache_dir(repo, cache_dir)
    total = 0
    if not root.is_dir():
        return 0
    for path in root.rglob("*"):
        try:
            if path.is_file() and not path.is_symlink():
                total += path.stat().st_size
        except OSError:
            continue
    return total


class Transcriber:
    def __init__(
        self,
        model_repo: str = DEFAULT_MODEL_REPO,
        cache_dir: str = "",
        ffmpeg_path: str = "ffmpeg",
    ) -> None:
        self.model_repo = (model_repo or "").strip() or DEFAULT_MODEL_REPO
        self.cache_dir = (cache_dir or "").strip()
        self.ffmpeg_path = ffmpeg_path
        self._model = None
        self._lock = threading.Lock()

    # -- model -------------------------------------------------------------

    def is_cached(self) -> bool:
        return is_model_cached(self.model_repo, self.cache_dir)

    def cached_bytes(self) -> int:
        return cache_bytes(self.model_repo, self.cache_dir)

    def expected_bytes(self) -> int | None:
        """Total download size from the Hub, or None when offline."""
        try:
            from huggingface_hub import HfApi

            info = HfApi().model_info(self.model_repo, files_metadata=True)
            sizes = [sibling.size for sibling in info.siblings or [] if sibling.size]
            return int(sum(sizes)) or None
        except Exception:  # noqa: BLE001 - offline is fine, caller falls back
            return None

    def download(self) -> None:
        """Fetch the model into the configured cache (blocking)."""
        try:
            from huggingface_hub import snapshot_download
        except ImportError as error:
            raise TranscriptionError("Downloading the model needs huggingface_hub") from error
        try:
            snapshot_download(
                repo_id=self.model_repo,
                cache_dir=hub_cache_dir(self.cache_dir),
            )
        except Exception as error:  # noqa: BLE001 - surfaced to the UI
            raise TranscriptionError(f"Could not download {self.model_repo}: {error}") from error

    def _load_model(self):
        with self._lock:
            if self._model is not None:
                return self._model
            try:
                from faster_whisper import WhisperModel
            except ImportError as error:
                raise TranscriptionError(
                    "faster-whisper is not installed. Run: pip install faster-whisper"
                ) from error
            try:
                self._model = WhisperModel(
                    self.model_repo,
                    device="auto",
                    compute_type="int8",
                    download_root=hub_cache_dir(self.cache_dir),
                )
            except Exception as error:  # noqa: BLE001 - surfaced to the UI verbatim
                raise TranscriptionError(
                    f"Could not load speech model {self.model_repo!r}: {error}"
                ) from error
            return self._model

    # -- transcription -----------------------------------------------------

    def transcribe(self, path: Path) -> str:
        return self.transcribe_result(path).text

    def transcribe_result(self, path: Path) -> TranscriptionResult:
        path = Path(path)
        if not path.is_file():
            raise TranscriptionError(f"Audio file not found: {path}")
        temporary: Path | None = None
        try:
            if path.suffix.lower() == ".wav" and _is_standard_wav(path):
                audio = load_wav_float32(path)
            else:
                try:
                    audio = decode_with_av(path)
                except TranscriptionError:
                    # Last resort for formats PyAV cannot open: system ffmpeg.
                    normalized = normalize_audio(path, self.ffmpeg_path)
                    temporary = normalized if normalized != path else None
                    audio = load_wav_float32(normalized)
            model = self._load_model()
            try:
                segments, _info = model.transcribe(
                    audio,
                    beam_size=5,
                    vad_filter=True,
                )
                collected = [
                    Segment(float(segment.start), float(segment.end), segment.text.strip())
                    for segment in segments
                    if segment.text.strip()
                ]
            except Exception as error:  # noqa: BLE001 - surfaced to the UI verbatim
                raise TranscriptionError(f"Transcription failed: {error}") from error
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return TranscriptionResult(
            text=" ".join(segment.text for segment in collected).strip(),
            segments=collected,
        )
