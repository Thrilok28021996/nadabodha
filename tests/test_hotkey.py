import pytest

from svara.hotkey import MOD_ALT, MOD_CMD, MOD_CTRL, MOD_SHIFT, HotkeyError, parse_hotkey
from svara.macos import display_hotkey


def test_parses_default_option_space():
    assert parse_hotkey("<alt>+<space>") == (49, MOD_ALT)


def test_parses_command_shift_letter():
    assert parse_hotkey("<cmd>+<shift>+r") == (15, MOD_CMD | MOD_SHIFT)


def test_parses_control_option_letter():
    assert parse_hotkey("<ctrl>+<option>+x") == (7, MOD_CTRL | MOD_ALT)


def test_parses_bare_letter_token():
    assert parse_hotkey("<alt>+k") == (40, MOD_ALT)


def test_rejects_missing_modifier():
    with pytest.raises(HotkeyError):
        parse_hotkey("<space>")


def test_rejects_unknown_token():
    with pytest.raises(HotkeyError):
        parse_hotkey("<alt>+<hyper>")


def test_rejects_empty_hotkey():
    with pytest.raises(HotkeyError):
        parse_hotkey("")


def test_hotkeys_get_distinct_ids():
    from svara.hotkey import CarbonHotkey

    first = CarbonHotkey("<alt>+<space>", lambda: None)
    second = CarbonHotkey("<cmd>+<shift>+r", lambda: None)
    assert first._id != second._id


def test_display_hotkey_renders_command_shift_letter():
    assert display_hotkey("<cmd>+<shift>+r") == "⌘+⇧+R"
    assert display_hotkey("<alt>+<space>") == "⌥+Space"
