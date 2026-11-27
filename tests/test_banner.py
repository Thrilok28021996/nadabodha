"""Dictation status banner: state, pulse and auto-hide."""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from svara.ui import banner as banner_module


@pytest.fixture(scope="module")
def app():
    return QApplication.instance() or QApplication([])


def test_busy_banner_shows_and_pulses(app):
    widget = banner_module.StatusBanner()
    widget.show_message("Transcribing…")
    assert widget.isVisible()
    assert widget._text.text() == "Transcribing…"
    assert widget._pulse.isActive()
    widget.close()


def test_success_hides_after_timeout(app):
    widget = banner_module.StatusBanner()
    widget.show_message("Pasted", banner_module.SUCCESS, timeout_ms=60)
    assert not widget._pulse.isActive()
    assert widget.isVisible()
    QTest.qWait(250)
    assert not widget.isVisible()


def test_error_uses_error_colour(app):
    widget = banner_module.StatusBanner()
    widget.show_message("No speech detected", banner_module.ERROR, timeout_ms=0)
    assert "#f38ba8" in widget._dot.styleSheet()
    widget.close()
