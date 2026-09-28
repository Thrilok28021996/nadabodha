#!/usr/bin/env python3
"""
Local transcription adapter for Nadabodha.

Runs in server mode (--server) and reads JSON commands from stdin, one per line.
Emits JSON events on stdout.

Commands:
  {"action": "transcribe", "file_path": ..., "model_repo": ..., "cache_dir": ...}
  {"action": "download_model", "repo_id": ..., "cache_dir": ...}
  {"action": "cancel"}
  {"action": "ping"}

Loader dispatch for the selected Hugging Face model (model_repo):
  * repos tagged ctranslate2 (Systran/faster-whisper-*) -> faster_whisper
  * PyTorch ASR repos (openai/whisper-*)               -> transformers pipeline
  * repos that cannot run locally as STT (ggerganov/
    whisper.cpp ggml-only, argmaxinc/whisperkit-coreml, pyannote/*
    diarization, mlx weights)                          -> immediate error event

Fallback chain when no (usable) HF model is configured:
  1. openai-whisper
  2. whisper.cpp (`whisper-cli` on PATH)
  3. Vosk
  4. Mock fallback that returns a placeholder transcript (no network, no upload)

Model downloads use huggingface_hub.snapshot_download with a progress-aware
tqdm class that emits JSON progress events on the same event stream; they are
cancellable (partial files stay resumable) and always honour cache_dir so
files land in the user-chosen directory instead of ~/.cache.

The mock fallback ensures the Electron scaffold can exercise IPC/state
end-to-end even when no model is installed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path
from typing import Any, Callable, Optional


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


# ---------------------------------------------------------------------------
# Cache directory handling
# ---------------------------------------------------------------------------

def apply_cache_dir(cache_dir: str) -> None:
    """Point every Hugging Face lookup at the user-chosen directory.

    Explicit cache_dir/download_root arguments are passed as well; this only
    makes implicit lookups agree with them so nothing ever lands in ~/.cache
    when the user picked a different folder.
    """
    if not cache_dir:
        return
    os.environ["HF_HOME"] = cache_dir
    os.environ["HF_HUB_CACHE"] = cache_dir


def _snapshot_present(repo_id: str, cache_dir: str) -> bool:
    """Loose check: a snapshot directory with at least one entry exists."""
    if not repo_id or not cache_dir:
        return False
    marker = "models--" + repo_id.replace("/", "--")
    snapshots = Path(cache_dir) / marker / "snapshots"
    if not snapshots.is_dir():
        return False
    try:
        for revision in snapshots.iterdir():
            if revision.is_dir() and any(revision.iterdir()):
                return True
    except OSError:
        return False
    return False


WEIGHT_FILE_RE = re.compile(r"\.(bin|safetensors|pt|pth|ckpt|onnx)$", re.IGNORECASE)
WEIGHT_INDEX_FILES = ("model.safetensors.index.json", "pytorch_model.bin.index.json")


def _revision_loadable(revision: Path) -> bool:
    """True when a snapshot revision holds every file a local loader needs."""
    try:
        files: list[Path] = []
        for path in revision.rglob("*"):
            if path.is_symlink() and not path.exists():
                return False  # blob never landed -> dangling pointer
            if path.is_file():
                files.append(path)
        if not files:
            return False
        config = revision / "config.json"
        if not config.is_file() or config.stat().st_size <= 0:
            return False
        weights = [p for p in files if WEIGHT_FILE_RE.search(p.name)]
        if not weights or any(p.stat().st_size <= 0 for p in weights):
            return False
        # Sharded checkpoints: every shard named by the index must be present.
        for index_name in WEIGHT_INDEX_FILES:
            index_path = revision / index_name
            if not index_path.is_file():
                continue
            parsed = json.loads(index_path.read_text(encoding="utf-8"))
            weight_map = parsed.get("weight_map") if isinstance(parsed, dict) else None
            if not isinstance(weight_map, dict):
                return False
            for weight_name in sorted({str(v) for v in weight_map.values()}):
                shard = revision / weight_name
                if not shard.is_file() or shard.stat().st_size <= 0:
                    return False
        return True
    except (OSError, ValueError):
        return False


def _snapshot_complete(repo_id: str, cache_dir: str) -> bool:
    """True only when the cached snapshot can actually be loaded.

    A cancelled or interrupted download still leaves a snapshot directory
    behind; treating that as installed makes the model unusable and
    unrecoverable from the UI. Completeness therefore requires:
      * no ``*.incomplete`` blob anywhere in the repo folder,
      * every ``refs/*`` entry resolving to a revision on disk,
      * at least one revision with a non-empty ``config.json``, a non-empty
        weight file, no broken symlinks and all sharded weights present.
    """
    if not repo_id or not cache_dir:
        return False
    marker = "models--" + repo_id.replace("/", "--")
    repo_dir = Path(cache_dir) / marker
    snapshots = repo_dir / "snapshots"
    if not snapshots.is_dir():
        return False
    try:
        if any(repo_dir.rglob("*.incomplete")):
            return False
        refs = repo_dir / "refs"
        if refs.is_dir():
            for ref in refs.iterdir():
                if not ref.is_file():
                    continue
                target = ref.read_text(encoding="utf-8").strip()
                if not target or not (snapshots / target).is_dir():
                    return False
        for revision in snapshots.iterdir():
            if revision.is_dir() and _revision_loadable(revision):
                return True
    except OSError:
        return False
    return False


# ---------------------------------------------------------------------------
# Hugging Face repo classification (mirrors src/main/hfModels.ts)
# ---------------------------------------------------------------------------

def classify_repo(
    repo_id: str,
    files: Optional[list[str]] = None,
    tags: Optional[list[str]] = None,
) -> tuple[str, str | None]:
    """Return (kind, reason).

    kind is one of "ctranslate2", "pytorch", "unsupported".
    """
    rid = (repo_id or "").lower()
    tag_list = [str(t).lower() for t in (tags or [])]
    file_list = [str(f).lower() for f in (files or [])]

    if rid.startswith("pyannote/") or "pyannote" in tag_list:
        return (
            "unsupported",
            "pyannote diarization model - speaker separation, not transcription",
        )

    ggml = "ggml" in tag_list or "whisper.cpp" in tag_list or "whisper.cpp" in rid
    ggml = ggml or any(
        re.match(r"(^|/)ggml[^/]*\.bin$", f) or f.endswith(".ggml") or f.endswith(".gguf")
        for f in file_list
    )
    if ggml:
        return (
            "unsupported",
            "ggml/whisper.cpp weights - this app does not bundle whisper.cpp",
        )

    if (
        rid.startswith("argmaxinc/whisperkit")
        or "coreml" in tag_list
        or any(f.endswith(".mlpackage") or ".mlmodelc" in f for f in file_list)
    ):
        return ("unsupported", "CoreML/WhisperKit package - not loadable by this app")

    if rid.startswith("mlx-community/") or "mlx" in tag_list:
        return ("unsupported", "MLX weights - this app runs faster-whisper/transformers, not MLX")

    if "ctranslate2" in tag_list or "ct2" in tag_list or "faster-whisper" in rid:
        return ("ctranslate2", None)

    if (
        "automatic-speech-recognition" in tag_list
        or "whisper" in tag_list
        or "whisper" in rid
    ):
        return ("pytorch", None)

    return ("unsupported", "not an automatic-speech-recognition model")


def _local_snapshot_files(repo_id: str, cache_dir: str) -> list[str]:
    """Filenames present in an already-downloaded snapshot (best effort)."""
    if not repo_id or not cache_dir:
        return []
    marker = "models--" + repo_id.replace("/", "--")
    snapshots = Path(cache_dir) / marker / "snapshots"
    if not snapshots.is_dir():
        return []
    names: list[str] = []
    try:
        for revision in snapshots.iterdir():
            for path in revision.rglob("*"):
                if path.is_file():
                    names.append(path.name)
    except OSError:
        return []
    return names


# ---------------------------------------------------------------------------
# Model download with progress events
# ---------------------------------------------------------------------------

class DownloadCancelled(Exception):
    """Raised inside progress callbacks to abort a snapshot download."""


#: The UI must see exactly one of these statuses for every download.
DOWNLOAD_TERMINAL_STATUSES = ("completed", "error", "cancelled")

#: How long a cancelled snapshot download gets to unwind on its own before the
#: terminal event is reported anyway. huggingface_hub's xet transport swallows
#: exceptions raised from the progress callback, so waiting for the transfer
#: itself would leave the UI stuck on "Downloading" indefinitely.
CANCEL_UNWIND_SECONDS = 0.5

#: A previously cancelled worker thread that is still unwinding delays a new
#: download by at most this long before we report an error instead.
STALE_WORKER_GRACE_SECONDS = 2.0

#: Worker thread of the download currently owned by this process (if any).
_ACTIVE_DOWNLOAD_WORKER: Optional[threading.Thread] = None


class TerminalEmitter:
    """Event sink wrapper that guarantees at most one terminal event.

    A download can end from several places at once (cancelled worker, safety
    timeout, broken pipe). Emitting two terminal events confuses the UI and
    emitting none leaves it stuck in "Downloading", so every terminal status
    is funnelled through this gate.
    """

    def __init__(self, on_event: Callable[[dict], None]) -> None:
        self._on_event = on_event
        self.sent = False

    def __call__(self, event: dict) -> None:
        if event.get("status") in DOWNLOAD_TERMINAL_STATUSES:
            if self.sent:
                return
            self.sent = True
        self._on_event(event)


class ProgressReporter:
    """Aggregates tqdm bar updates into throttled JSON progress events."""

    def __init__(self, on_event: Callable[[dict], None], repo_id: str, cancel_event: threading.Event):
        self.on_event = on_event
        self.repo_id = repo_id
        self.cancel_event = cancel_event
        self.bytes_done = 0
        self.bytes_total = 0
        self.files_done = 0
        self.files_total = 0
        self.last_emit = 0.0
        self.last_percent = -1

    def check_cancelled(self) -> None:
        if self.cancel_event.is_set():
            raise DownloadCancelled()

    def record(self, bar) -> None:  # noqa: ANN001 - tqdm bar instance
        unit = getattr(bar, "unit", "")
        if unit == "B":
            self.bytes_done = int(getattr(bar, "n", 0) or 0)
            self.bytes_total = int(getattr(bar, "total", 0) or 0)
        elif unit == "it":
            self.files_done = int(getattr(bar, "n", 0) or 0)
            self.files_total = int(getattr(bar, "total", 0) or 0)
        self.maybe_emit()

    def maybe_emit(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self.last_emit < 0.25:
            return
        percent = self.percent()
        if percent < self.last_percent:
            # huggingface_hub grows the aggregate byte total as file metadata
            # arrives, which would otherwise make the bar jump backwards.
            percent = self.last_percent
        if percent == self.last_percent and not force:
            return
        self.last_emit = now
        self.last_percent = percent
        self.on_event({
            "status": "downloading",
            "origin": "download",
            "repo_id": self.repo_id,
            "progress": percent,
            "bytes_done": self.bytes_done,
            "bytes_total": self.bytes_total,
        })

    def percent(self) -> int:
        if self.bytes_total > 0:
            return max(0, min(99, int(self.bytes_done * 100 / self.bytes_total)))
        if self.files_total > 0:
            return max(0, min(99, int(self.files_done * 100 / self.files_total)))
        return 0


def _make_progress_tqdm(reporter: ProgressReporter):
    """Build a tqdm subclass that reports progress and honours cancellation."""
    try:
        from huggingface_hub.utils import tqdm as hf_tqdm
    except Exception:  # pragma: no cover - huggingface_hub is a hard dep in prod
        from tqdm import tqdm as hf_tqdm  # type: ignore

    class ProgressTqdm(hf_tqdm):  # type: ignore[misc,valid-type]
        def __init__(self, *args, **kwargs):  # noqa: ANN001
            super().__init__(*args, **kwargs)
            # tqdm returns early for disabled bars and never assigns several
            # attributes (unit/desc/initial). snapshot_download builds its
            # aggregate byte bar with disable=<non-tty>, so without restoring
            # `unit` the byte counters stay at 0 and the percentage jumps per
            # finished file instead of tracking bytes.
            if not hasattr(self, "unit"):
                self.unit = kwargs.get("unit") or "it"
            if not hasattr(self, "desc"):
                self.desc = kwargs.get("desc") or ""
            if not hasattr(self, "initial"):
                self.initial = kwargs.get("initial") or 0

        def update(self, n: int = 1):  # noqa: ANN001
            reporter.check_cancelled()
            if getattr(self, "disable", False):
                self.n = int(getattr(self, "n", 0) or 0) + n
            else:
                super().update(n)
            reporter.record(self)
            reporter.check_cancelled()
            return getattr(self, "n", None)

    return ProgressTqdm


def download_model(
    repo_id: str,
    cache_dir: str,
    on_event: Callable[[dict], None],
    cancel_event: threading.Event,
) -> bool:
    """snapshot_download with progress + cancellation. Returns True on success.

    Exactly one terminal event (completed / error / cancelled) is always
    emitted - even when the hub cannot be interrupted mid-transfer.
    """
    emit = TerminalEmitter(on_event)
    try:
        return _download_model(repo_id, cache_dir, emit, cancel_event)
    except BaseException as exc:  # noqa: BLE001 - the UI must always hear back
        if not emit.sent:
            if cancel_event.is_set():
                emit({"status": "cancelled", "origin": "download", "repo_id": repo_id})
            else:
                emit({
                    "status": "error",
                    "origin": "download",
                    "repo_id": repo_id,
                    "error": f"Download failed: {exc}",
                })
        return False


def _download_model(
    repo_id: str,
    cache_dir: str,
    emit: TerminalEmitter,
    cancel_event: threading.Event,
) -> bool:
    global _ACTIVE_DOWNLOAD_WORKER
    apply_cache_dir(cache_dir)
    try:
        from huggingface_hub import snapshot_download
    except Exception as exc:
        emit({
            "status": "error",
            "origin": "download",
            "repo_id": repo_id,
            "error": f"huggingface_hub not available: {exc}",
        })
        return False

    # A cancelled download may still be unwinding inside the hub (xet keeps
    # transferring until its current file ends). Never run two writers
    # against the same cache directory.
    stale = _ACTIVE_DOWNLOAD_WORKER
    if stale is not None and stale.is_alive():
        stale.join(STALE_WORKER_GRACE_SECONDS)
        if stale.is_alive():
            emit({
                "status": "error",
                "origin": "download",
                "repo_id": repo_id,
                "error": "Another model download is still shutting down - retry in a moment",
            })
            return False

    reporter = ProgressReporter(emit, repo_id, cancel_event)
    progress_tqdm = _make_progress_tqdm(reporter)
    reporter.maybe_emit(force=True)

    result: dict = {}

    def _worker() -> None:
        try:
            result["folder"] = snapshot_download(
                repo_id,
                cache_dir=cache_dir or None,
                tqdm_class=progress_tqdm,
                max_workers=4,
            )
        except BaseException as exc:  # noqa: BLE001 - reported by the caller
            result["exc"] = exc

    worker = threading.Thread(target=_worker, name="nadabodha-hf-download", daemon=True)
    _ACTIVE_DOWNLOAD_WORKER = worker
    worker.start()

    # Poll instead of blocking on snapshot_download: cancellation must be
    # noticed within a few milliseconds, whatever the transport does with it.
    while worker.is_alive():
        worker.join(0.05)
        if cancel_event.is_set():
            break

    if worker.is_alive() and cancel_event.is_set():
        # Give the hub a short chance to unwind cleanly, then report anyway:
        # the xet transport swallows the abort raised from its progress
        # callback, so waiting for the transfer could take minutes.
        worker.join(CANCEL_UNWIND_SECONDS)

    if worker.is_alive():
        emit({"status": "cancelled", "origin": "download", "repo_id": repo_id})
        return False

    exc = result.get("exc")
    if exc is None:
        emit({
            "status": "completed",
            "origin": "download",
            "repo_id": repo_id,
            "path": result.get("folder"),
            "progress": 100,
        })
        return True
    if isinstance(exc, DownloadCancelled) or cancel_event.is_set():
        emit({"status": "cancelled", "origin": "download", "repo_id": repo_id})
        return False
    emit({
        "status": "error",
        "origin": "download",
        "repo_id": repo_id,
        "error": f"Download failed: {exc}",
    })
    return False


# ---------------------------------------------------------------------------
# Transcribers
# ---------------------------------------------------------------------------

class BaseTranscriber:
    def __init__(self, on_event: Callable[[dict], None]) -> None:
        self.on_event = on_event
        self._cancelled = False
        self._cancel_event = threading.Event()

    def cancel(self) -> None:
        self._cancelled = True
        self._cancel_event.set()

    def transcribe(self, file_path: str) -> None:
        raise NotImplementedError

    def _ensure_model(self, repo_id: str, cache_dir: str) -> bool:
        """Download the HF snapshot on demand (with progress). False = stopped."""
        if not cache_dir:
            return True
        if _snapshot_complete(repo_id, cache_dir):
            return True
        # Partial/cancelled snapshots are re-fetched here: the hub resumes
        # whatever already landed instead of offering a broken model.
        self.on_event({
            "status": "downloading",
            "origin": "download",
            "repo_id": repo_id,
            "progress": 0,
        })
        if not download_model(repo_id, cache_dir, self.on_event, self._cancel_event):
            self._report_download_stop(
                f"Model {repo_id} could not be downloaded - transcription stopped"
            )
            return False
        if not _snapshot_complete(repo_id, cache_dir):
            self.on_event({
                "status": "error",
                "origin": "download",
                "repo_id": repo_id,
                "error": (
                    f"{repo_id} is still incomplete after downloading - "
                    "required files are missing or truncated"
                ),
            })
            self._report_download_stop(
                f"Model {repo_id} is incomplete - transcription stopped"
            )
            return False
        return True

    def _report_download_stop(self, message: str) -> None:
        """Emit the terminal event for the transcription itself.

        Download events carry ``origin: download`` and must not advance the
        transcription state machine, so a transcription that stops because of
        the download still needs its own terminal event - otherwise the UI
        stays on "Transcribing".
        """
        if self._cancelled:
            self.on_event({"status": "cancelled"})
        else:
            self.on_event({"status": "error", "error": message})


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


class FasterWhisperTranscriber(BaseTranscriber):
    """CTranslate2 (Systran/faster-whisper-*) repos via faster-whisper."""

    def __init__(
        self,
        on_event: Callable[[dict], None],
        repo_id: str,
        cache_dir: str = "",
    ) -> None:
        super().__init__(on_event)
        self.repo_id = repo_id
        self.cache_dir = cache_dir

    def transcribe(self, file_path: str) -> None:
        try:
            from faster_whisper import WhisperModel  # type: ignore
        except Exception as exc:
            self.on_event({"status": "error", "error": f"faster-whisper not available: {exc}"})
            return

        if not self._ensure_model(self.repo_id, self.cache_dir):
            return  # download failed or was cancelled; event already emitted

        self.on_event({"status": "transcribing", "progress": 5})
        try:
            model = WhisperModel(
                self.repo_id,
                device="cpu",
                compute_type="int8",
                download_root=self.cache_dir or None,
                local_files_only=True,
            )
        except Exception as exc:
            self.on_event({"status": "error", "error": f"faster-whisper load failed: {exc}"})
            return

        try:
            segments, info = model.transcribe(file_path, beam_size=1)
            duration = float(getattr(info, "duration", 0) or 0)
            parts: list[str] = []
            for segment in segments:
                if self._cancelled:
                    self.on_event({"status": "cancelled"})
                    return
                parts.append(segment.text or "")
                if duration > 0:
                    progress = int(min(95, max(5, segment.end / duration * 100)))
                    self.on_event({"status": "transcribing", "progress": progress})
            text = "".join(parts).strip()
            self.on_event({"status": "completed", "text": text})
        except Exception as exc:
            self.on_event({"status": "error", "error": f"faster-whisper error: {exc}"})


def build_asr_pipeline(
    repo_id: str,
    cache_dir: str = "",
    pipeline_fn: Optional[Callable[..., Any]] = None,
) -> Callable[..., dict]:
    """Construct the transformers ASR pipeline for a repo.

    ``cache_dir`` is handed over as ``model_kwargs`` so it only reaches the
    ``from_pretrained`` calls for the model/tokenizer/processor. It must never
    be a bare ``pipeline(...)`` kwarg: the pipeline forwards unknown kwargs
    into ``generate()`` and transformers rejects them with "The following
    model_kwargs are not used by the model: [cache_dir]".
    """
    if pipeline_fn is None:
        from transformers import pipeline as fn  # type: ignore
    else:
        fn = pipeline_fn
    kwargs: dict = {"model": repo_id}
    if cache_dir:
        kwargs["model_kwargs"] = {"cache_dir": cache_dir}
    return fn("automatic-speech-recognition", **kwargs)


class TransformersWhisperTranscriber(BaseTranscriber):
    """PyTorch ASR repos (openai/whisper-*) via the transformers pipeline."""

    def __init__(
        self,
        on_event: Callable[[dict], None],
        repo_id: str,
        cache_dir: str = "",
    ) -> None:
        super().__init__(on_event)
        self.repo_id = repo_id
        self.cache_dir = cache_dir

    def transcribe(self, file_path: str) -> None:
        try:
            from transformers import pipeline  # type: ignore
        except Exception as exc:
            self.on_event({"status": "error", "error": f"transformers not available: {exc}"})
            return

        if not self._ensure_model(self.repo_id, self.cache_dir):
            return

        self.on_event({"status": "transcribing", "progress": 20})
        try:
            pipe = build_asr_pipeline(self.repo_id, self.cache_dir)
            self.on_event({"status": "transcribing", "progress": 50})
            if "whisper" in self.repo_id.lower():
                result = pipe(file_path, chunk_length_s=30, batch_size=8)
            else:
                result = pipe(file_path)
            if self._cancelled:
                self.on_event({"status": "cancelled"})
                return
            self.on_event({"status": "transcribing", "progress": 90})
            text = str(result.get("text", "")).strip()
            self.on_event({"status": "completed", "text": text})
        except Exception as exc:
            self.on_event({"status": "error", "error": f"transformers error: {exc}"})


class ErrorTranscriber(BaseTranscriber):
    """Forced selection of a repo that cannot run locally as STT."""

    def __init__(self, on_event: Callable[[dict], None], message: str) -> None:
        super().__init__(on_event)
        self.message = message

    def transcribe(self, file_path: str) -> None:
        self.on_event({"status": "error", "error": self.message})


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


def _choose_transcriber(
    on_event: Callable[[dict], None],
    model_repo: str = "",
    cache_dir: str = "",
) -> BaseTranscriber:
    if os.environ.get("NADABODHA_MOCK_TRANSCRIBE") == "1":
        return MockTranscriber(on_event)

    if model_repo:
        files = _local_snapshot_files(model_repo, cache_dir)
        kind, reason = classify_repo(model_repo, files=files)
        if kind == "unsupported":
            return ErrorTranscriber(
                on_event,
                f"Model {model_repo} cannot run locally as STT: {reason}",
            )
        if kind == "ctranslate2":
            try:
                import faster_whisper  # noqa: F401

                return FasterWhisperTranscriber(on_event, model_repo, cache_dir)
            except Exception:
                pass  # library missing -> keep following the fallback chain
        else:
            try:
                import transformers  # noqa: F401

                return TransformersWhisperTranscriber(on_event, model_repo, cache_dir)
            except Exception:
                pass

    # Fallback chain: openai-whisper -> whisper.cpp -> vosk -> mock.
    try:
        import whisper  # noqa: F401

        return WhisperTranscriber(on_event)
    except Exception:
        pass
    if shutil.which("whisper-cli") or shutil.which("main"):
        return WhisperCppTranscriber(on_event)
    try:
        import vosk  # noqa: F401

        return VoskTranscriber(on_event)
    except Exception:
        pass
    return MockTranscriber(on_event)


def _run_server() -> None:
    transcriber: BaseTranscriber | None = None
    download_thread: threading.Thread | None = None
    download_cancel = threading.Event()

    def on_event(event: dict) -> None:
        emit(event)

    def run_download(cancel: threading.Event, repo_id: str, cache_dir: str) -> None:
        try:
            download_model(repo_id, cache_dir, on_event, cancel)
        except Exception as exc:  # never let a thread error kill the server
            emit({
                "status": "error",
                "origin": "download",
                "repo_id": repo_id,
                "error": f"Download failed: {exc}",
            })

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
            cache_dir = command.get("cache_dir") or ""
            model_repo = command.get("model_repo") or ""
            apply_cache_dir(cache_dir)
            transcriber = _choose_transcriber(on_event, model_repo, cache_dir)
            thread = threading.Thread(target=transcriber.transcribe, args=(wav_path,), daemon=True)
            thread.start()
        elif action == "download_model":
            repo_id = command.get("repo_id")
            if not repo_id or not isinstance(repo_id, str):
                emit({"status": "error", "origin": "download", "error": "repo_id is required"})
                continue
            cache_dir = command.get("cache_dir") or ""
            # Classify before touching the network: repos that cannot run
            # locally as STT are refused with an error event.
            kind, reason = classify_repo(repo_id)
            if kind == "unsupported":
                emit({
                    "status": "error",
                    "origin": "download",
                    "repo_id": repo_id,
                    "error": f"{repo_id} cannot run locally as STT: {reason}",
                })
                continue
            if download_thread is not None and download_thread.is_alive():
                emit({
                    "status": "error",
                    "origin": "download",
                    "repo_id": repo_id,
                    "error": "Another model download is already running",
                })
                continue
            apply_cache_dir(cache_dir)
            download_cancel = threading.Event()
            download_thread = threading.Thread(
                target=run_download,
                args=(download_cancel, repo_id, cache_dir),
                daemon=True,
            )
            download_thread.start()
        elif action == "cancel":
            handled = False
            if download_thread is not None and download_thread.is_alive():
                download_cancel.set()
                handled = True
            if transcriber:
                transcriber.cancel()
                handled = True
            if not handled:
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
