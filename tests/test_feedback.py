from svara import feedback


def test_preview_collapses_whitespace():
    assert feedback.preview("  hello\n world\t!") == "hello world !"


def test_preview_truncates_with_ellipsis():
    text = "word " * 100
    result = feedback.preview(text, limit=40)
    assert len(result) == 40
    assert result.endswith("…")


def test_preview_keeps_short_text():
    assert feedback.preview("short", limit=40) == "short"


def test_notify_passes_body_and_title_to_osascript(monkeypatch):
    calls = []

    class Completed:
        returncode = 0

    def fake_run(args, **kwargs):
        calls.append(args)
        return Completed()

    monkeypatch.setattr(feedback.subprocess, "run", fake_run)
    assert feedback.notify("Title", "hello there") is True
    assert calls[0][0] == "osascript"
    assert "display notification" in calls[0][2]
    assert calls[0][-2:] == ["hello there", "Title"]


def test_notify_reports_failure(monkeypatch):
    class Completed:
        returncode = 1

    monkeypatch.setattr(feedback.subprocess, "run", lambda *a, **k: Completed())
    assert feedback.notify("Title", "body") is False
