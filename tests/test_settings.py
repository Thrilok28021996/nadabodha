import json

from svara.models import DEFAULT_MODEL_REPO
from svara.settings import DEFAULT_PROMPT, Settings, default_cache_dir


def test_defaults():
    settings = Settings()
    assert settings.model_repo == DEFAULT_MODEL_REPO
    assert settings.llm_base_url == "http://127.0.0.1:1234/v1"
    assert settings.summarization_enabled is True
    assert settings.dictation_enabled is True
    assert settings.prompt_template == DEFAULT_PROMPT
    assert settings.stt_cache_dir == default_cache_dir()
    assert settings.output_dir == "/Volumes/personal/meetings"
    assert settings.recording_hotkey == "<cmd>+<shift>+r"
    assert settings.dictation_chime is True
    assert settings.dictation_notification is True
    assert settings.theme == "mocha"


def test_load_missing_file_returns_defaults(tmp_path):
    assert Settings.load(tmp_path / "settings.json").model_repo == DEFAULT_MODEL_REPO


def test_save_and_load_roundtrip(tmp_path):
    path = tmp_path / "settings.json"
    settings = Settings(
        model_repo="openai/whisper-small",
        llm_model="qwen",
        llm_api_key="secret",
        auto_summarize=False,
        dictation_hotkey="<ctrl>+<space>",
        prompt_template="Prompt:\n{{transcript}}",
    )
    settings.save(path)
    loaded = Settings.load(path)
    assert loaded.model_repo == "openai/whisper-small"
    assert loaded.llm_model == "qwen"
    assert loaded.llm_api_key == "secret"
    assert loaded.auto_summarize is False
    assert loaded.dictation_hotkey == "<ctrl>+<space>"
    assert loaded.prompt_template == "Prompt:\n{{transcript}}"


def test_wrong_types_are_ignored(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "model_repo": 42,
                "summarization_enabled": "yes",
                "unknown_key": "ignored",
                "dictation_hotkey": "",
            }
        ),
        encoding="utf-8",
    )
    loaded = Settings.load(path)
    assert loaded.model_repo == DEFAULT_MODEL_REPO
    assert loaded.summarization_enabled is True
    assert loaded.dictation_hotkey == "<alt>+<space>"


def test_old_default_model_is_migrated(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"model_repo": "Systran/faster-whisper-base"}), encoding="utf-8")
    assert Settings.load(path).model_repo == DEFAULT_MODEL_REPO


def test_explicit_model_choice_is_preserved(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"model_repo": "openai/whisper-small"}), encoding="utf-8")
    assert Settings.load(path).model_repo == "openai/whisper-small"


def test_legacy_electron_settings_are_migrated(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "activeModel": "Systran/faster-whisper-base",
                "sttCacheDir": "/Users/tester/.cache/huggingface",
                "llmBaseUrl": "http://127.0.0.1:1234/v1",
                "llmModel": "spark-x2.6-4b",
                "summarizationEnabled": True,
                "autoSummarize": False,
                "dictationEnabled": False,
                "recordingShortcut": "CommandOrControl+Shift+R",
            }
        ),
        encoding="utf-8",
    )
    loaded = Settings.load(path)
    assert loaded.model_repo == DEFAULT_MODEL_REPO
    assert loaded.stt_cache_dir == "/Users/tester/.cache/huggingface"
    assert loaded.llm_model == "spark-x2.6-4b"
    assert loaded.auto_summarize is False
    assert loaded.dictation_enabled is False
    # The Electron recording accelerator must never become the dictation hotkey.
    assert loaded.dictation_hotkey == "<alt>+<space>"
    assert loaded.recording_hotkey == "<cmd>+<shift>+r"


def test_electron_recording_accelerator_is_not_a_dictation_hotkey(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps({"dictation_hotkey": "CommandOrControl+Shift+R"}),
        encoding="utf-8",
    )
    assert Settings.load(path).dictation_hotkey == "<alt>+<space>"


def test_legacy_custom_prompts_become_presets(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "customPrompts": [
                    {"id": "general", "name": "General", "template": "T {{transcript}}"},
                    {"id": "minutes", "name": "Minutes", "template": "M {{transcript}}"},
                ]
            }
        ),
        encoding="utf-8",
    )
    loaded = Settings.load(path)
    assert [preset["name"] for preset in loaded.prompt_presets] == ["General", "Minutes"]
    assert loaded.prompt_presets[1]["template"].startswith("M ")


def test_default_prompt_presets_exist():
    presets = Settings().prompt_presets
    assert presets and presets[0]["name"] == "General summary"
    assert "{{transcript}}" in presets[0]["template"]


def test_int_setting_is_parsed(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"max_recording_minutes": 45}), encoding="utf-8")
    assert Settings.load(path).max_recording_minutes == 45


def test_corrupt_file_is_backed_up(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text("{not json", encoding="utf-8")
    loaded = Settings.load(path)
    assert loaded.model_repo == DEFAULT_MODEL_REPO
    assert (tmp_path / "settings.json.corrupt").exists()
    assert not path.exists()


def test_save_is_atomic_and_valid_json(tmp_path):
    path = tmp_path / "nested" / "settings.json"
    Settings(llm_model="probe").save(path)
    assert not (path.parent / "settings.json.tmp").exists()
    assert json.loads(path.read_text(encoding="utf-8"))["llm_model"] == "probe"
