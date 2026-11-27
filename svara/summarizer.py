"""Summaries through any local OpenAI-compatible server (LM Studio, llama.cpp…).

Only the standard library is used, keeping the app dependency-light. Failures
are raised as ``SummarizationError`` with a human-readable message; the UI logs
them and shows them in the status bar.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Tuple

_PLACEHOLDER = re.compile(r"\{\{\s*transcript\s*\}\}")


class SummarizationError(RuntimeError):
    """The local LLM could not produce a summary."""


def build_user_prompt(template: str, transcript: str) -> str:
    source = template or ""
    if _PLACEHOLDER.search(source):
        return _PLACEHOLDER.sub(lambda _match: transcript, source)
    header = source.strip()
    return f"{header}\n\nTranscript:\n{transcript}" if header else f"Transcript:\n{transcript}"


def build_request(
    base_url: str,
    model: str,
    prompt: str,
    api_key: str = "",
    system_prompt: str = "",
    max_tokens: int = 1200,
    temperature: float = 0.2,
) -> Tuple[str, bytes, Dict[str, str]]:
    """Return ``(url, body, headers)`` for a chat-completions call (testable)."""
    url = (base_url or "").strip().rstrip("/") + "/chat/completions"
    messages = []
    if system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt.strip()})
    messages.append({"role": "user", "content": prompt})
    body: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": False,
    }
    if max_tokens > 0:
        body["max_tokens"] = max_tokens
    headers = {"Content-Type": "application/json"}
    if api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"
    return url, json.dumps(body).encode("utf-8"), headers


def _post(url: str, body: bytes, headers: Dict[str, str], timeout: float) -> bytes:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - local URL
        return response.read()


def list_models(base_url: str, api_key: str = "", timeout: float = 5.0) -> list[str]:
    """Return the model ids the local server advertises (OpenAI ``/models``)."""
    base = (base_url or "").strip().rstrip("/")
    if not base:
        raise SummarizationError("Set the summary server URL in Settings first.")
    headers = {"Content-Type": "application/json"}
    if api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"
    request = urllib.request.Request(f"{base}/models", headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - local URL
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise SummarizationError(f"Model list failed (HTTP {error.code})") from error
    except urllib.error.URLError as error:
        raise SummarizationError(f"Cannot reach the summary server: {error.reason}") from error
    except (TimeoutError, ValueError) as error:
        raise SummarizationError(f"Could not read the model list: {error}") from error
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        raise SummarizationError("The server did not return a model list.")
    return [str(item["id"]) for item in data if isinstance(item, dict) and item.get("id")]


def probe_model(base_url: str, model: str, api_key: str = "", timeout: float = 60.0) -> float:
    """Send a tiny prompt and return the round-trip seconds.

    Detects servers that are reachable but whose selected model never produces
    text (reasoning models with a small budget, or a model that is loading).
    """
    url, body, headers = build_request(
        base_url,
        model,
        "Reply with the single word OK.",
        api_key=api_key,
        system_prompt="Answer directly, with no explanation.",
        max_tokens=128,
    )
    started = time.monotonic()
    try:
        raw = _post(url, body, headers, timeout)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace").strip()[:200]
        raise SummarizationError(f"Model test failed (HTTP {error.code}): {detail}") from error
    except urllib.error.URLError as error:
        raise SummarizationError(f"Cannot reach the summary server: {error.reason}") from error
    except TimeoutError as error:
        raise SummarizationError(
            f"{model} did not answer within {timeout:.0f}s. Try a non-reasoning model."
        ) from error
    payload = json.loads(raw.decode("utf-8"))
    if not Summarizer._content(payload):
        raise SummarizationError(
            f"{model} returned no text. Reasoning models often spend a small budget thinking; "
            "try a non-reasoning model such as lfm3-omni-2b."
        )
    return time.monotonic() - started


class Summarizer:
    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str = "",
        timeout: float = 300.0,
        max_tokens: int = 4096,
    ) -> None:
        self.base_url = (base_url or "").strip()
        self.model = (model or "").strip()
        self.api_key = api_key
        self.timeout = timeout
        self.max_tokens = max(256, int(max_tokens or 4096))

    def _request(self, transcript: str, template: str, max_tokens: int) -> Any:
        url, body, headers = build_request(
            self.base_url,
            self.model,
            build_user_prompt(template, transcript),
            api_key=self.api_key,
            system_prompt="You summarize speech accurately. Return Markdown only.",
            max_tokens=max_tokens,
        )
        try:
            raw = _post(url, body, headers, self.timeout)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace").strip()[:300]
            raise SummarizationError(f"Summary failed (HTTP {error.code}): {detail}") from error
        except urllib.error.URLError as error:
            raise SummarizationError(f"Cannot reach the summary server: {error.reason}") from error
        except TimeoutError as error:
            raise SummarizationError(
                f"Summary timed out after {self.timeout:.0f}s with {self.model}. "
                "Long transcripts and reasoning models are slow; try a non-reasoning model."
            ) from error
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SummarizationError(f"Summary server returned invalid JSON: {error}") from error

    @staticmethod
    def _content(payload: Any) -> str:
        try:
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            return ""
        return content.strip() if isinstance(content, str) else ""

    @staticmethod
    def _finish_reason(payload: Any) -> str:
        try:
            return str(payload["choices"][0].get("finish_reason") or "")
        except (KeyError, IndexError, TypeError, AttributeError):
            return ""

    def summarize(self, transcript: str, template: str) -> str:
        if not self.base_url or not self.model:
            raise SummarizationError("Set the summary server URL and model in Settings first.")
        if not transcript.strip():
            raise SummarizationError("Nothing to summarize: the transcript is empty.")
        payload = self._request(transcript, template, self.max_tokens)
        text = self._content(payload)
        if not text and self._finish_reason(payload) == "length":
            # Reasoning models can spend the whole budget thinking and return
            # an empty content field; retry once with double the room.
            payload = self._request(transcript, template, min(self.max_tokens * 2, 16384))
            text = self._content(payload)
        if not text:
            raise SummarizationError(
                "The summary server returned no content. If the model reasons before answering, "
                "raise Max tokens in Settings or choose a non-reasoning model."
            )
        return text
