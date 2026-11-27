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

import concurrent.futures
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

#: MLX (Apple GPU) build of the same large-v3-turbo weights. Same architecture
#: and licence, stored as float16 for Metal. Faster than the int8 CTranslate2
#: build on short audio; not more accurate, because mlx_whisper cannot do beam
#: search, so it decodes greedily where the CPU path uses beam-5.
DEFAULT_MLX_MODEL_REPO = "mlx-community/whisper-large-v3-turbo"

#: Marker file that proves a model snapshot is complete, per backend. CTranslate2
#: ships ``model.bin``; MLX ships ``weights.safetensors``.
CT2_MODEL_FILE = "model.bin"
MLX_MODEL_FILE = "weights.safetensors"


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


def is_model_cached(repo: str, cache_dir: str, filename: str = CT2_MODEL_FILE) -> bool:
    root = repo_cache_dir(repo, cache_dir)
    snapshots = root / "snapshots"
    if not snapshots.is_dir():
        return False
    for snapshot in snapshots.iterdir():
        model = snapshot / filename
        try:
            if model.is_file() and model.stat().st_size > 1_000_000:
                return True
        except OSError:
            continue
    return False


def mlx_available() -> bool:
    """True when Apple's MLX runtime and its Metal backend can actually run."""
    try:
        import mlx.core as mx  # noqa: PLC0415 - optional dependency
        import mlx_whisper  # noqa: F401,PLC0415 - presence check only
    except Exception:  # noqa: BLE001 - absent on non-Apple hardware
        return False
    try:
        return bool(mx.metal.is_available())
    except Exception:  # noqa: BLE001 - older mlx builds
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


# -- the one MLX thread ----------------------------------------------------
#
# mlx_whisper caches its model in a process-global ModelHolder, and the model's
# compute state belongs to the thread that first materialised it: loading on
# one thread and evaluating on another raises
# ``RuntimeError: There is no Stream(gpu, 1) in current thread`` from
# ``mx.async_eval`` inside mlx_whisper's decoding. Exactly one thread in the
# process may therefore both load and evaluate the model. The executor is
# module level (not per Transcriber instance) for the same reason: a second
# instance would otherwise evaluate the process-global cached model on a fresh
# thread and recreate the defect. It is created lazily on first MLX use, so a
# CPU-only run never starts the thread.

_mlx_executor: concurrent.futures.ThreadPoolExecutor | None = None
_mlx_worker_ident: int | None = None
_mlx_executor_lock = threading.Lock()


def _run_on_mlx_worker(work):
    """Run *work* on the dedicated MLX thread and return its result.

    Exceptions propagate unchanged (``Future.result`` re-raises what the call
    raised), so callers keep wrapping them in their own error types. When the
    caller already *is* the MLX thread the callable runs inline: a nested
    submit would queue behind the running task and deadlock a single-worker
    pool.
    """
    if threading.get_ident() == _mlx_worker_ident:
        return work()
    global _mlx_executor
    with _mlx_executor_lock:
        if _mlx_executor is None:
            _mlx_executor = concurrent.futures.ThreadPoolExecutor(
                max_workers=1, thread_name_prefix="svara-mlx"
            )
        executor = _mlx_executor

    def record_ident_and_run():
        # First use records the pool thread's ident for the re-entrancy check
        # above; max_workers=1 keeps that ident stable for the pool's lifetime.
        global _mlx_worker_ident
        _mlx_worker_ident = threading.get_ident()
        return work()

    return executor.submit(record_ident_and_run).result()


class Transcriber:
    """Transcribe audio, on the GPU (MLX) for dictation and the CPU otherwise.

    Both backends run the same large-v3-turbo weights. The GPU is used for short
    dictation takes, where the fixed per-call cost dominates: 1.1s against
    5.9s on the CPU for a 6.4 s clip.

    Recordings and imports deliberately stay on the CPU path. ``mlx_whisper``
    implements neither beam search nor VAD, so routing them through the GPU
    would silently change how meetings are decoded -- a different algorithm, not
    just a different device, and not what this app has been verified against.
    """

    def __init__(
        self,
        model_repo: str = DEFAULT_MODEL_REPO,
        cache_dir: str = "",
        ffmpeg_path: str = "ffmpeg",
        backend: str = "auto",
        mlx_model_repo: str = DEFAULT_MLX_MODEL_REPO,
    ) -> None:
        self.model_repo = (model_repo or "").strip() or DEFAULT_MODEL_REPO
        self.cache_dir = (cache_dir or "").strip()
        self.ffmpeg_path = ffmpeg_path
        self.backend = (backend or "auto").strip().lower()
        self.mlx_model_repo = (mlx_model_repo or "").strip() or DEFAULT_MLX_MODEL_REPO
        self._model = None
        self._lock = threading.Lock()
        self._use_mlx: bool | None = None
        self._mlx_path: str | None = None

    # -- backend -----------------------------------------------------------

    @property
    def use_mlx(self) -> bool:
        """Whether this machine can transcribe on the Apple GPU."""
        if self._use_mlx is None:
            if self.backend == "cpu":
                self._use_mlx = False
            elif self.backend == "mlx":
                # Trust the explicit request; a missing runtime surfaces as a
                # TranscriptionError with a fixable message at transcribe time
                # rather than silently falling back to a slower backend.
                self._use_mlx = True
            else:
                self._use_mlx = self._auto_prefers_mlx()
        return self._use_mlx

    def _auto_prefers_mlx(self) -> bool:
        """Prefer the GPU, but never ask for a second download to get there.

        An existing install already has the CTranslate2 weights cached and no
        MLX weights. Silently switching it to the GPU would mean a surprise
        ~1.5 GB download on the next take, so in that case the cached CPU model
        wins. When neither is cached the GPU is the better thing to fetch.
        """
        if not mlx_available():
            return False
        if is_model_cached(self.mlx_model_repo, self.cache_dir, MLX_MODEL_FILE):
            return True
        if is_model_cached(self.model_repo, self.cache_dir, CT2_MODEL_FILE):
            return False
        return True

    def plan(self, allow_gpu: bool | None = None) -> tuple[bool, str, str]:
        """``(use_mlx, repo, marker_file)`` for one transcription call.

        ``allow_gpu=False`` forces the CPU path for that call. That is what keeps
        recordings and imports on exactly the decoding they have always used:
        mlx_whisper implements neither beam search nor VAD, so sending meetings
        through it would silently change their accuracy.
        """
        use_mlx = self.use_mlx and allow_gpu is not False
        if use_mlx:
            return True, self.mlx_model_repo, MLX_MODEL_FILE
        return False, self.model_repo, CT2_MODEL_FILE

    @property
    def active_repo(self) -> str:
        """Repo for the default call path, used for reporting and tests."""
        return self.plan()[1]

    @property
    def model_file(self) -> str:
        return self.plan()[2]

    # -- model -------------------------------------------------------------

    def is_cached(self, allow_gpu: bool | None = None) -> bool:
        _mlx, repo, filename = self.plan(allow_gpu)
        return is_model_cached(repo, self.cache_dir, filename)

    def cached_bytes(self, allow_gpu: bool | None = None) -> int:
        return cache_bytes(self.plan(allow_gpu)[1], self.cache_dir)

    def expected_bytes(self, allow_gpu: bool | None = None) -> int | None:
        """Total download size from the Hub, or None when offline."""
        repo = self.plan(allow_gpu)[1]
        try:
            from huggingface_hub import HfApi

            info = HfApi().model_info(repo, files_metadata=True)
            sizes = [sibling.size for sibling in info.siblings or [] if sibling.size]
            return int(sum(sizes)) or None
        except Exception:  # noqa: BLE001 - offline is fine, caller falls back
            return None

    def download(self, allow_gpu: bool | None = None) -> None:
        """Fetch the model into the configured cache (blocking)."""
        repo = self.plan(allow_gpu)[1]
        try:
            from huggingface_hub import snapshot_download
        except ImportError as error:
            raise TranscriptionError("Downloading the model needs huggingface_hub") from error
        try:
            snapshot_download(
                repo_id=repo,
                cache_dir=hub_cache_dir(self.cache_dir),
            )
        except Exception as error:  # noqa: BLE001 - surfaced to the UI
            raise TranscriptionError(f"Could not download {repo}: {error}") from error

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

    def preload(self, allow_gpu: bool | None = None) -> None:
        """Load the model now so the first transcription does not pay for it.

        Dictation is short and the model load is several seconds, so loading it
        up front in a worker thread removes that wait from the first take. The
        GPU plan loads on the dedicated MLX thread so the model is
        materialised on the same thread that will later evaluate it; the CPU
        plan loads directly on the caller thread.
        """
        if self.plan(allow_gpu)[0]:
            _run_on_mlx_worker(self._load_mlx_model)
            return
        self._load_model()

    def _mlx_model_path(self) -> str:
        """Resolve the MLX snapshot inside *our* cache and hand mlx a local path.

        ``mlx_whisper`` resolves a repo id with a bare ``snapshot_download()``,
        which ignores the app's configured model cache and would silently fetch a
        second 1.5 GB copy into the default HF home. Downloading through our own
        cache directory and passing the resulting path keeps one copy, in the
        directory the Settings dialog shows.
        """
        if self._mlx_path is not None:
            return self._mlx_path
        try:
            from huggingface_hub import snapshot_download
        except ImportError as error:
            raise TranscriptionError("The GPU backend needs huggingface_hub") from error
        try:
            self._mlx_path = str(
                snapshot_download(
                    repo_id=self.mlx_model_repo,
                    cache_dir=hub_cache_dir(self.cache_dir),
                )
            )
        except Exception as error:  # noqa: BLE001 - surfaced to the UI
            raise TranscriptionError(f"Could not download {self.mlx_model_repo}: {error}") from error
        return self._mlx_path

    def _load_mlx_model(self):
        """Populate mlx_whisper's own model cache so a warm call skips the load.

        Called under ``self._lock``: ``ModelHolder.get_model`` has no locking of
        its own, so a preload racing a dictation would load the 1.6 GB model
        twice and write the class attribute racily.
        """
        try:
            import mlx.core as mx
            from mlx_whisper.transcribe import ModelHolder
        except ImportError as error:
            raise TranscriptionError(
                "The GPU backend needs mlx-whisper. Run: pip install mlx-whisper "
                "(or set the speech backend to CPU in Settings)."
            ) from error
        with self._lock:
            path = self._mlx_model_path()
            try:
                return ModelHolder.get_model(path, mx.float16)
            except Exception as error:  # noqa: BLE001 - surfaced to the UI
                raise TranscriptionError(
                    f"Could not load GPU speech model {self.mlx_model_repo!r}: {error}"
                ) from error

    def _transcribe_mlx(
        self,
        audio: np.ndarray,
        language: str | None,
        without_timestamps: bool,
    ) -> list[Segment]:
        try:
            import mlx_whisper
        except ImportError as error:
            raise TranscriptionError(
                "The GPU backend needs mlx-whisper. Run: pip install mlx-whisper "
                "(or set the speech backend to CPU in Settings)."
            ) from error

        def load_and_transcribe():
            # Load and decode in one callable on the dedicated MLX thread: the
            # model's compute state belongs to the thread that materialised it,
            # so splitting the two across threads raises
            # "There is no Stream(gpu, 1) in current thread" from mx.async_eval.
            self._load_mlx_model()
            # One MLX call at a time: mlx_whisper's model cache is process-global and
            # unlocked, so a concurrent load/transcribe would double-load the model.
            # Held only inside this callable -- never around the submit, which
            # would deadlock the single-worker pool once a second caller arrives.
            with self._lock:
                path = self._mlx_model_path()
                try:
                    return mlx_whisper.transcribe(
                        audio,
                        path_or_hf_repo=path,
                        language=language or None,
                        without_timestamps=without_timestamps,
                        verbose=None,
                    )
                except Exception as error:  # noqa: BLE001 - surfaced to the UI verbatim
                    raise TranscriptionError(f"Transcription failed: {error}") from error

        result = _run_on_mlx_worker(load_and_transcribe)
        collected: list[Segment] = []
        for segment in result.get("segments") or []:
            text = str(segment.get("text") or "").strip()
            if not text:
                continue
            collected.append(
                Segment(float(segment.get("start", 0.0)), float(segment.get("end", 0.0)), text)
            )
        return collected

    def transcribe(self, path: Path, **options: object) -> str:
        return self.transcribe_result(path, **options).text

    def transcribe_result(
        self,
        path: Path,
        *,
        language: str | None = None,
        without_timestamps: bool = False,
        allow_gpu: bool | None = None,
    ) -> TranscriptionResult:
        """Transcribe ``path``.

        ``language`` skips Whisper's language-detection pass, which is a whole
        extra encoder run over the 30s window and therefore the single largest
        fixed cost of a short dictation take. ``None`` keeps auto-detection.

        ``without_timestamps`` stops the decoder emitting timestamp tokens. Turn
        it on only where timings are unused (dictation): SRT/VTT export needs
        them.

        ``allow_gpu`` gates the GPU backend for this call alone. Pass ``False``
        for recordings and imports so they keep the CPU path's beam search and
        VAD, neither of which mlx_whisper implements.
        """
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
            if self.plan(allow_gpu)[0]:
                collected = self._transcribe_mlx(audio, language, without_timestamps)
                return TranscriptionResult(
                    text=" ".join(segment.text for segment in collected).strip(),
                    segments=collected,
                )
            model = self._load_model()
            try:
                segments, _info = model.transcribe(
                    audio,
                    beam_size=5,
                    vad_filter=True,
                    language=(language or None),
                    without_timestamps=without_timestamps,
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
