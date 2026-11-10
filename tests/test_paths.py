from pathlib import Path

from svara import paths
from svara.macos import display_hotkey


def test_data_dir_override(monkeypatch, tmp_path):
    monkeypatch.setenv("SVARA_DATA_DIR", str(tmp_path / "custom"))
    assert paths.user_data_dir() == tmp_path / "custom"
    assert paths.recordings_dir() == tmp_path / "custom" / "recordings"
    assert paths.log_path() == tmp_path / "custom" / "logs" / "svara.log"


def test_default_data_dir_is_under_application_support(monkeypatch):
    monkeypatch.delenv("SVARA_DATA_DIR", raising=False)
    directory = paths.user_data_dir()
    if paths.sys.platform == "darwin":
        assert directory == Path.home() / "Library" / "Application Support" / "Svara"
    else:
        assert directory.name == "Svara"


def test_mac_paste_helper_is_bundled():
    helper = paths.mac_paste_helper()
    assert helper.is_file()


def test_display_hotkey_symbols():
    assert display_hotkey("<alt>+<space>") == "⌥+Space"
    assert display_hotkey("<cmd>+<shift>+r") == "⌘+⇧+R"
