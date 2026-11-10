import json

import pytest

from svara import summarizer as summarizer_module
from svara.summarizer import (
    SummarizationError,
    Summarizer,
    build_request,
    build_user_prompt,
    list_models,
)


def test_build_user_prompt_replaces_placeholder():
    assert build_user_prompt("Summary:\n{{transcript}}", "hello") == "Summary:\nhello"
    assert build_user_prompt("{{ transcript }}", "hello") == "hello"


def test_build_user_prompt_appends_when_placeholder_missing():
    prompt = build_user_prompt("Summarize this.", "hello")
    assert prompt.startswith("Summarize this.")
    assert prompt.endswith("Transcript:\nhello")


def test_build_request_shape_and_auth():
    url, body, headers = build_request(
        "http://127.0.0.1:1234/v1/",
        "local-model",
        "prompt",
        api_key="secret",
        system_prompt="be brief",
        max_tokens=99,
    )
    assert url == "http://127.0.0.1:1234/v1/chat/completions"
    payload = json.loads(body)
    assert payload["model"] == "local-model"
    assert payload["max_tokens"] == 99
    assert payload["messages"][0] == {"role": "system", "content": "be brief"}
    assert payload["messages"][-1] == {"role": "user", "content": "prompt"}
    assert headers["Authorization"] == "Bearer secret"


def test_build_request_without_key_has_no_auth_header():
    _url, _body, headers = build_request("http://localhost:1234/v1", "m", "p")
    assert "Authorization" not in headers


def test_summarize_returns_content(monkeypatch):
    payload = {"choices": [{"message": {"content": "  ## Summary\nok  "}}]}
    monkeypatch.setattr(
        summarizer_module,
        "_post",
        lambda url, body, headers, timeout: json.dumps(payload).encode(),
    )
    summarizer = Summarizer("http://127.0.0.1:1234/v1", "model")
    assert summarizer.summarize("transcript", "{{transcript}}") == "## Summary\nok"


def test_summarize_requires_configuration():
    with pytest.raises(SummarizationError):
        Summarizer("", "model").summarize("text", "{{transcript}}")
    with pytest.raises(SummarizationError):
        Summarizer("http://127.0.0.1:1234/v1", "").summarize("text", "{{transcript}}")


def test_summarize_rejects_empty_transcript():
    with pytest.raises(SummarizationError):
        Summarizer("http://127.0.0.1:1234/v1", "model").summarize("   ", "{{transcript}}")


def test_summarize_rejects_empty_content(monkeypatch):
    payload = {"choices": [{"message": {"content": "   "}}]}
    monkeypatch.setattr(
        summarizer_module,
        "_post",
        lambda url, body, headers, timeout: json.dumps(payload).encode(),
    )
    with pytest.raises(SummarizationError):
        Summarizer("http://127.0.0.1:1234/v1", "model").summarize("text", "{{transcript}}")


def test_list_models_parses_ids(monkeypatch):
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return b'{"data": [{"id": "local-model"}, {"id": "other"}]}'

    monkeypatch.setattr(
        summarizer_module.urllib.request,
        "urlopen",
        lambda request, timeout=0: Response(),
    )
    assert list_models("http://127.0.0.1:1234/v1") == ["local-model", "other"]


def test_list_models_requires_url():
    with pytest.raises(SummarizationError):
        list_models("")


def _payload(content, finish="stop"):
    return {"choices": [{"message": {"content": content}, "finish_reason": finish}]}


def test_empty_content_retries_with_more_tokens(monkeypatch):
    calls = []

    def fake_post(url, body, headers, timeout):
        import json

        calls.append(json.loads(body)["max_tokens"])
        if len(calls) == 1:
            return json.dumps(_payload("", "length")).encode()
        return json.dumps(_payload("## Overview\nDone.", "stop")).encode()

    monkeypatch.setattr(summarizer_module, "_post", fake_post)
    summarizer = Summarizer("http://127.0.0.1:1234/v1", "model", max_tokens=1024)
    assert summarizer.summarize("hello", "{{transcript}}").startswith("## Overview")
    assert calls == [1024, 2048]


def test_empty_content_without_length_fails_clearly(monkeypatch):
    import json

    monkeypatch.setattr(
        summarizer_module,
        "_post",
        lambda *a, **k: json.dumps(_payload("", "stop")).encode(),
    )
    summarizer = Summarizer("http://127.0.0.1:1234/v1", "model")
    with pytest.raises(SummarizationError) as captured:
        summarizer.summarize("hello", "{{transcript}}")
    assert "no content" in str(captured.value)


def test_probe_model_reports_seconds(monkeypatch):
    import json

    monkeypatch.setattr(
        summarizer_module,
        "_post",
        lambda *a, **k: json.dumps(_payload("OK", "stop")).encode(),
    )
    seconds = summarizer_module.probe_model("http://127.0.0.1:1234/v1", "model")
    assert seconds >= 0


def test_probe_model_flags_empty_content(monkeypatch):
    import json

    monkeypatch.setattr(
        summarizer_module,
        "_post",
        lambda *a, **k: json.dumps(_payload("", "length")).encode(),
    )
    with pytest.raises(SummarizationError) as captured:
        summarizer_module.probe_model("http://127.0.0.1:1234/v1", "spark")
    assert "returned no text" in str(captured.value)
