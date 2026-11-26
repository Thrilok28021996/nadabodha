"""Persisted user preferences (``settings.json``).

Reads are forgiving: a missing file yields defaults, a corrupt file is moved
aside to ``settings.json.corrupt`` and defaults are used, and values of the
wrong type are ignored. Writes are atomic (temp file + rename) so a crash
mid-save cannot leave the app without settings.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any, Dict, List

from .models import DEFAULT_MODEL_REPO, LEGACY_DEFAULT_MODEL_REPOS

DEFAULT_PROMPT = """# Summarization prompt

You are a careful assistant summarizing a speech-to-text transcript.
Write in the same language as the transcript.

Answer with valid Markdown only, using exactly these sections:

## Overview
One paragraph summarizing what was said.

## Key points
- A short bullet list of the most important points.

## Action items
- A bullet list of things to do. Give each item an owner when one was
  mentioned in the transcript, otherwise write "-".

Rules:
- Do not invent facts: only use what the transcript actually says.
- Keep headings, lists and paragraphs as valid Markdown (## headings, "- " bullets).
- If the transcript is empty or meaningless, say so in the Overview.

Transcript:
{{transcript}}
"""


def default_cache_dir() -> str:
    env = (os.environ.get("HF_HOME") or "").strip()
    if env:
        return env
    return str(Path.home() / ".cache" / "huggingface")


def _migrate_model_repo(value: str) -> str:
    """Map the old built-in default (or a blank value) to the turbo model."""
    candidate = (value or "").strip()
    if candidate in LEGACY_DEFAULT_MODEL_REPOS:
        return DEFAULT_MODEL_REPO
    return candidate


def _migrate_hotkey(value: str) -> str:
    """Reject Electron recording accelerators copied into the dictation slot."""
    candidate = (value or "").strip()
    lowered = candidate.lower()
    if not candidate:
        return "<alt>+<space>"
    if "commandorcontrol" in lowered or "cmdorctrl" in lowered:
        return "<alt>+<space>"
    return candidate


def _migrate_recording_hotkey(value: str) -> str:
    """Normalise an Electron accelerator ("CommandOrControl+Shift+R") to pynput form."""
    candidate = (value or "").strip()
    if not candidate:
        return "<cmd>+<shift>+r"
    if "<" in candidate:
        return candidate
    parts: list[str] = []
    for token in candidate.split("+"):
        lowered = token.strip().lower()
        if not lowered:
            continue
        if lowered in {"commandorcontrol", "cmdorctrl", "command", "cmd"}:
            parts.append("<cmd>")
        elif lowered in {"control", "ctrl"}:
            parts.append("<ctrl>")
        elif lowered in {"alt", "option", "opt"}:
            parts.append("<alt>")
        elif lowered == "shift":
            parts.append("<shift>")
        elif lowered == "space":
            parts.append("<space>")
        elif len(lowered) == 1:
            parts.append(lowered)
        else:
            return "<cmd>+<shift>+r"
    return "+".join(parts) if parts else "<cmd>+<shift>+r"


def _normalise_language(value: str) -> str:
    """Dictation language: a code, or ``auto`` to let Whisper detect it.

    Anything empty falls back to English because that is what this app is used
    for, and pinning the language skips a whole encoder pass per dictation.
    Anything that is not a language Whisper knows is rejected here rather than
    left to fail mid-dictation as a raw "Transcription failed" banner.
    """
    candidate = (value or "").strip().lower()
    if not candidate:
        return "en"
    if candidate == "auto":
        return "auto"
    base = candidate.split("-")[0]
    if base in KNOWN_LANGUAGES:
        return candidate
    return "en"


#: ISO-639-1 codes Whisper accepts, plus a few multilingual aliases it knows.
KNOWN_LANGUAGES = frozenset(
    """
    af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr
    gl gu ha haw he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv
    mg mi mk ml mn mr ms mt my ne nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn
    so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo yue zh
    """.split()
)


#: Electron-era camelCase keys that map onto current settings fields.
_LEGACY_KEYS = {
    "model_repo": "activeModel",
    "stt_cache_dir": "sttCacheDir",
    "llm_base_url": "llmBaseUrl",
    "llm_model": "llmModel",
    "llm_api_key": "llmApiKey",
    "summarization_enabled": "summarizationEnabled",
    "auto_summarize": "autoSummarize",
    "dictation_enabled": "dictationEnabled",
    "dictation_paste_enabled": "dictationPasteEnabled",
    "recording_hotkey": "recordingShortcut",
    "watch_folder": "watchFolderDir",
}


@dataclass
class Settings:
    model_repo: str = DEFAULT_MODEL_REPO
    stt_cache_dir: str = field(default_factory=default_cache_dir)
    stt_backend: str = "auto"
    output_dir: str = "/Volumes/personal/meetings"
    theme: str = "mocha"
    llm_base_url: str = "http://127.0.0.1:1234/v1"
    llm_model: str = ""
    llm_api_key: str = ""
    llm_max_tokens: int = 4096
    summarization_enabled: bool = True
    auto_summarize: bool = True
    dictation_enabled: bool = True
    dictation_paste_enabled: bool = True
    dictation_hotkey: str = "<alt>+<space>"
    recording_hotkey: str = "<cmd>+<shift>+r"
    dictation_chime: bool = True
    dictation_notification: bool = True
    max_recording_minutes: int = 0
    input_device: str = ""
    audio_source: str = "microphone"
    watch_folder: str = ""
    dictation_language: str = "en"
    preload_model: bool = True
    prompt_template: str = DEFAULT_PROMPT
    prompt_presets: List[Dict[str, str]] = field(
        default_factory=lambda: [{"name": "General summary", "template": DEFAULT_PROMPT}]
    )

    # -- serialization -----------------------------------------------------

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: Any) -> "Settings":
        settings = cls()
        if not isinstance(raw, dict):
            return settings
        # The Electron build stored camelCase keys in the same file. Carry
        # those values over so an upgrade keeps the user's LLM and dictation
        # configuration instead of silently resetting it.
        source = dict(raw)
        for key, legacy_key in _LEGACY_KEYS.items():
            if key not in source and legacy_key in source:
                source[key] = source[legacy_key]
        for item in fields(cls):
            key = item.name
            if key not in source:
                continue
            value = source[key]
            if key == "prompt_template" and isinstance(value, str) and value.strip():
                settings.prompt_template = value
                continue
            expected = type(getattr(settings, key))
            if expected is str and isinstance(value, str):
                setattr(settings, key, value.strip())
            elif expected is bool and isinstance(value, bool):
                setattr(settings, key, value)
            elif expected is int and isinstance(value, int) and not isinstance(value, bool):
                setattr(settings, key, max(0, value))
        if not settings.dictation_hotkey.strip():
            settings.dictation_hotkey = cls().dictation_hotkey
        raw_presets = source.get("prompt_presets") or source.get("customPrompts")
        if isinstance(raw_presets, list):
            cleaned: List[Dict[str, str]] = []
            for item in raw_presets:
                if not isinstance(item, dict):
                    continue
                template = item.get("template")
                if not isinstance(template, str) or not template.strip():
                    continue
                cleaned.append({"name": str(item.get("name") or "Preset"), "template": template})
            if cleaned:
                settings.prompt_presets = cleaned
        settings.model_repo = _migrate_model_repo(settings.model_repo)
        settings.dictation_hotkey = _migrate_hotkey(settings.dictation_hotkey)
        settings.recording_hotkey = _migrate_recording_hotkey(settings.recording_hotkey)
        if settings.theme not in {"mocha", "latte"}:
            settings.theme = "mocha"
        if settings.audio_source not in {"microphone", "system", "both"}:
            settings.audio_source = "microphone"
        if settings.stt_backend not in {"auto", "mlx", "cpu"}:
            settings.stt_backend = "auto"
        settings.dictation_language = _normalise_language(settings.dictation_language)
        return settings

    # -- persistence -------------------------------------------------------

    @classmethod
    def load(cls, path: Path) -> "Settings":
        path = Path(path)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return cls()
        except (OSError, ValueError):
            _backup_corrupt(path)
            return cls()
        if not isinstance(raw, dict):
            _backup_corrupt(path)
            return cls()
        return cls.from_dict(raw)

    def save(self, path: Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(self.to_dict(), indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)
        try:
            # Settings may contain an API key; keep the file private.
            path.chmod(0o600)
        except OSError:
            pass


def _backup_corrupt(path: Path) -> None:
    try:
        backup = path.with_name(path.name + ".corrupt")
        if backup.exists():
            backup.unlink()
        path.replace(backup)
    except OSError:
        # Recovery must not fail because the backup itself failed.
        return
