#!/usr/bin/env python3
"""Fetch the faster-whisper large-v3-turbo weights into the Hugging Face cache.

The HF CDN throttles a single connection hard on some networks, and the xet
transport can stall midway. This script downloads ``model.bin`` as parallel
HTTP range requests into the blob location ``hf_hub_download`` expects, so the
normal cache lookup works afterwards. Small metadata files are fetched with
``hf_hub_download`` itself.

Usage:
    HF_HOME=/path/to/hf python3 scripts/fetch_turbo_model.py
"""

from __future__ import annotations

import hashlib
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from huggingface_hub import hf_hub_download, model_info

REPO = "deepdml/faster-whisper-large-v3-turbo-ct2"
WORKERS = 16
CHUNK = 8 * 1024 * 1024


def log(message: str) -> None:
    print(message, flush=True)


def download_range(url: str, start: int, end: int, attempts: int = 4) -> bytes:
    last_error: Exception | None = None
    for attempt in range(attempts):
        request = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                data = response.read()
            if len(data) != end - start + 1:
                raise IOError(f"short range {start}-{end}: {len(data)} bytes")
            return data
        except Exception as error:  # noqa: BLE001 - retried below
            last_error = error
            time.sleep(1 + attempt * 2)
    raise IOError(f"range {start}-{end} failed: {last_error}")


def main() -> int:
    info = model_info(REPO, files_metadata=True)
    commit = info.sha
    sibling = next(item for item in info.siblings if item.rfilename == "model.bin")
    if sibling.lfs is None or sibling.size is None:
        raise SystemExit("model.bin has no LFS metadata")
    size: int = sibling.size
    sha256: str = sibling.lfs.sha256
    url = f"https://huggingface.co/{REPO}/resolve/main/model.bin"

    cache_root = Path(
        os.environ.get("HUGGINGFACE_HUB_CACHE")
        or os.environ.get("HF_HUB_CACHE")
        or Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub"
    )
    repo_dir = cache_root / ("models--" + REPO.replace("/", "--"))
    blob = repo_dir / "blobs" / sha256
    snapshot = repo_dir / "snapshots" / commit
    snapshot.mkdir(parents=True, exist_ok=True)
    blob.parent.mkdir(parents=True, exist_ok=True)

    # Small files: normal hub download is instant and creates refs/snapshots.
    for name in ("config.json", "tokenizer.json", "vocabulary.json", "preprocessor_config.json"):
        hf_hub_download(REPO, name, cache_dir=str(cache_root))
        log(f"metadata ready: {name}")

    link = snapshot / "model.bin"
    if blob.exists() and blob.stat().st_size == size:
        log(f"blob already complete: {blob}")
    else:
        blob.unlink(missing_ok=True)
        for stale in blob.parent.glob(sha256 + ".*.incomplete"):
            stale.unlink(missing_ok=True)
        descriptor = os.open(blob, os.O_CREAT | os.O_RDWR, 0o644)
        os.ftruncate(descriptor, size)
        ranges = [(start, min(start + CHUNK - 1, size - 1)) for start in range(0, size, CHUNK)]
        log(f"downloading {size/1e9:.2f} GB in {len(ranges)} chunks with {WORKERS} workers")
        started = time.time()
        done = 0
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            futures = {
                pool.submit(download_range, url, start, end): (start, end) for start, end in ranges
            }
            try:
                for future in as_completed(futures):
                    start, _end = futures[future]
                    os.pwrite(descriptor, future.result(), start)
                    done += 1
                    if done % 16 == 0 or done == len(ranges):
                        elapsed = time.time() - started
                        rate = (done * CHUNK) / max(elapsed, 1) / 1e6
                        log(f"{done}/{len(ranges)} chunks  {rate:.2f} MB/s")
            finally:
                os.close(descriptor)
        if blob.stat().st_size != size:
            raise IOError(f"size mismatch: {blob.stat().st_size} != {size}")

    log("verifying sha256…")
    digest = hashlib.sha256()
    with blob.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != sha256:
        raise IOError(f"sha256 mismatch: {digest.hexdigest()} != {sha256}")
    log("sha256 OK")

    if not link.exists():
        link.symlink_to(Path("../../blobs") / sha256)
    log(f"ready: {snapshot}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
