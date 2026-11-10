from pathlib import Path

import pytest

from svara import paste


def test_copy_to_clipboard_uses_pbcopy(monkeypatch):
    calls = []

    class Completed:
        returncode = 0

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return Completed()

    monkeypatch.setattr(paste.subprocess, "run", fake_run)
    paste.copy_to_clipboard("hello")
    assert calls[0][0] == ["pbcopy"]
    assert calls[0][1]["input"] == b"hello"


def test_paste_returns_pasted_when_helper_succeeds(tmp_path, monkeypatch):
    helper = tmp_path / "mac-paste"
    helper.write_text("#!/bin/sh\nexit 0\n")
    helper.chmod(0o755)
    monkeypatch.setattr(paste, "copy_to_clipboard", lambda text: None)
    monkeypatch.setattr(paste, "secure_input_enabled", lambda: False)
    monkeypatch.setattr(paste, "accessibility_trusted", lambda: True)
    monkeypatch.setattr(paste, "_quartz_paste", lambda: False)
    assert paste.paste_at_cursor("hello", helper=helper) == paste.PASTED


def test_secure_input_is_detected_before_pasting(monkeypatch):
    monkeypatch.setattr(paste, "copy_to_clipboard", lambda text: None)
    monkeypatch.setattr(paste, "secure_input_enabled", lambda: True)
    assert paste.paste_at_cursor("secret") == paste.SECURE_INPUT


def test_missing_accessibility_falls_back_to_clipboard(monkeypatch):
    monkeypatch.setattr(paste, "copy_to_clipboard", lambda text: None)
    monkeypatch.setattr(paste, "secure_input_enabled", lambda: False)
    monkeypatch.setattr(paste, "accessibility_trusted", lambda: False)
    assert paste.paste_at_cursor("hello") == paste.NO_ACCESSIBILITY


def test_failed_helper_and_applescript_leave_text_on_clipboard(monkeypatch):
    monkeypatch.setattr(paste, "copy_to_clipboard", lambda text: None)
    monkeypatch.setattr(paste, "secure_input_enabled", lambda: False)
    monkeypatch.setattr(paste, "accessibility_trusted", lambda: True)
    monkeypatch.setattr(paste, "_quartz_paste", lambda: False)
    monkeypatch.setattr(paste, "_run_applescript", lambda timeout: False)
    assert paste.paste_at_cursor("hello", helper=Path("/nonexistent/helper")) == paste.CLIPBOARD_ONLY


def test_quartz_paste_is_preferred(monkeypatch):
    monkeypatch.setattr(paste, "copy_to_clipboard", lambda text: None)
    monkeypatch.setattr(paste, "secure_input_enabled", lambda: False)
    monkeypatch.setattr(paste, "accessibility_trusted", lambda: True)
    monkeypatch.setattr(paste, "_quartz_paste", lambda: True)
    assert paste.paste_at_cursor("hello") == paste.PASTED


def test_clipboard_failure_is_reported(monkeypatch):
    def explode(text):
        raise OSError("pbcopy missing")

    monkeypatch.setattr(paste, "copy_to_clipboard", explode)
    assert paste.paste_at_cursor("hello") == paste.FAILED
