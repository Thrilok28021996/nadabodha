import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_LLM_BASE_URL,
  SettingsStore,
  defaultSettings,
  loadSettings,
  mergeSettings,
  resolvePythonExecutable,
  saveSettings,
  settingsFilePath,
  validatePythonInterpreter,
} from './settingsStore';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nadabodha-settings-'));
}

describe('defaultSettings', () => {
  it('uses HF_HOME for the model cache when set', () => {
    const settings = defaultSettings({ HF_HOME: '/Volumes/custom/hf' } as NodeJS.ProcessEnv, '/Users/tester');
    expect(settings.sttCacheDir).toBe('/Volumes/custom/hf');
    expect(settings.llmBaseUrl).toBe(DEFAULT_LLM_BASE_URL);
    expect(settings.pythonPath).toBe('');
    expect(settings.dataDir).toBe('');
    expect(settings.summarizationEnabled).toBe(true);
    expect(settings.autoSummarize).toBe(true);
    expect(settings.activeModel).toBe('');
    // Out-of-the-box auto-summarize target (LM Studio serves this model).
    expect(settings.llmModel).toBe('mistralai/ministral-3-3b');
  });

  it('falls back to ~/.cache/huggingface when HF_HOME is unset', () => {
    const settings = defaultSettings({} as NodeJS.ProcessEnv, '/Users/tester');
    expect(settings.sttCacheDir).toBe(path.join('/Users/tester', '.cache', 'huggingface'));
  });
});

describe('mergeSettings', () => {
  it('overrides only correctly typed values', () => {
    const base = defaultSettings({} as NodeJS.ProcessEnv, '/Users/tester');
    const merged = mergeSettings(base, {
      pythonPath: '/usr/local/bin/python3',
      llmModel: 'qwen',
      autoSummarize: false,
      summarizationEnabled: 'nope',
      dataDir: 42,
      unknownKey: 'ignored',
    } as never);
    expect(merged.pythonPath).toBe('/usr/local/bin/python3');
    expect(merged.llmModel).toBe('qwen');
    expect(merged.autoSummarize).toBe(false);
    // wrong-typed values are ignored, not persisted
    expect(merged.summarizationEnabled).toBe(true);
    expect(merged.dataDir).toBe('');
    expect((merged as never as Record<string, unknown>).unknownKey).toBeUndefined();
  });

  it('returns the base unchanged for a null patch', () => {
    const base = defaultSettings({} as NodeJS.ProcessEnv, '/Users/tester');
    expect(mergeSettings(base, null as never)).toEqual(base);
  });
});

describe('loadSettings / saveSettings', () => {
  it('returns defaults when the file does not exist', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'settings.json');
    expect(loadSettings(file, {}, '/Users/tester')).toEqual(defaultSettings({}, '/Users/tester'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips saved settings', () => {
    const dir = tmpDir();
    const file = settingsFilePath(dir);
    const settings = {
      ...defaultSettings({}, '/Users/tester'),
      pythonPath: '/Volumes/personal/conda_envs/misc/bin/python3',
      llmBaseUrl: 'http://127.0.0.1:1234/v1',
      llmModel: 'neohorse-1-4b-mlx',
      dataDir: '/tmp/data',
      activeModel: 'Systran/faster-whisper-base',
      autoSummarize: false,
    };
    saveSettings(file, settings);
    expect(loadSettings(file, {}, '/Users/tester')).toEqual(settings);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recovers from a corrupt JSON file', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{ this is not json', 'utf8');

    const loaded = loadSettings(file, {}, '/Users/tester');
    expect(loaded).toEqual(defaultSettings({}, '/Users/tester'));
    // the unreadable file is preserved for inspection, not silently deleted
    expect(fs.existsSync(`${file}.corrupt`)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);

    // and the next save works normally
    saveSettings(file, loaded);
    expect(loadSettings(file, {}, '/Users/tester')).toEqual(loaded);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recovers from valid JSON that is not an object', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '["array","not","object"]', 'utf8');
    expect(loadSettings(file, {}, '/Users/tester')).toEqual(defaultSettings({}, '/Users/tester'));
    expect(fs.existsSync(`${file}.corrupt`)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('SettingsStore', () => {
  it('merges patches and persists them', () => {
    const dir = tmpDir();
    const store = new SettingsStore(path.join(dir, 'settings.json'), {}, '/Users/tester');

    const first = store.update({ llmModel: 'qwen3.5-9b-mlx', autoSummarize: false });
    expect(first.llmModel).toBe('qwen3.5-9b-mlx');
    expect(first.autoSummarize).toBe(false);
    // untouched fields keep their defaults
    expect(first.llmBaseUrl).toBe(DEFAULT_LLM_BASE_URL);

    const second = store.update({ dataDir: '/tmp/nadabodha-data' });
    expect(second.llmModel).toBe('qwen3.5-9b-mlx');
    expect(second.dataDir).toBe('/tmp/nadabodha-data');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('resolvePythonExecutable', () => {
  const env = { NADABODHA_PYTHON: '/env/python3' } as NodeJS.ProcessEnv;

  it('prefers the saved setting', () => {
    expect(resolvePythonExecutable({ pythonPath: '/saved/python3' }, env)).toBe('/saved/python3');
    expect(resolvePythonExecutable({ pythonPath: '  ' }, env)).toBe('/env/python3');
  });

  it('falls back to NADABODHA_PYTHON', () => {
    expect(resolvePythonExecutable({ pythonPath: '' }, env)).toBe('/env/python3');
    expect(resolvePythonExecutable(undefined, env)).toBe('/env/python3');
  });

  it('falls back to python3 on PATH', () => {
    expect(resolvePythonExecutable({ pythonPath: '' }, {} as NodeJS.ProcessEnv)).toBe('python3');
    expect(resolvePythonExecutable({ pythonPath: '' }, { NADABODHA_PYTHON: '   ' } as NodeJS.ProcessEnv)).toBe('python3');
  });
});

describe('validatePythonInterpreter', () => {
  it('treats an empty path as unset but valid', async () => {
    const result = await validatePythonInterpreter('', async () => ({ ok: true, message: 'unused' }));
    expect(result.ok).toBe(true);
    expect(result.blocking).toBe(false);
    expect(result.message).toContain('python3 from PATH');
  });

  it('rejects a path that does not exist', async () => {
    const result = await validatePythonInterpreter('/does/not/exist/python3');
    expect(result.ok).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.message).toContain('not found');
  });

  it('rejects a directory', async () => {
    const dir = tmpDir();
    const result = await validatePythonInterpreter(dir);
    expect(result.ok).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.message).toContain('Not a file');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a non-executable file', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'python3');
    fs.writeFileSync(file, '#!/bin/sh\n', 'utf8');
    fs.chmodSync(file, 0o644);
    const result = await validatePythonInterpreter(file);
    expect(result.ok).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.message).toContain('Not executable');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a failed import probe inline but keeps it savable', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'python3');
    fs.writeFileSync(file, '#!/bin/sh\nexit 1\n', 'utf8');
    fs.chmodSync(file, 0o755);

    const result = await validatePythonInterpreter(file, async (target) => ({
      ok: false,
      message: `Probe failed: ModuleNotFoundError: No module named 'whisper' (${target})`,
    }));
    expect(result.ok).toBe(false);
    expect(result.blocking).toBe(false);
    expect(result.message).toContain('ModuleNotFoundError');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts an executable whose probe succeeds', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'python3');
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(file, 0o755);

    const result = await validatePythonInterpreter(file, async () => ({ ok: true, message: 'OK' }));
    expect(result).toEqual({ ok: true, blocking: false, message: 'OK' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns a specific message when the real probe binary is missing', async () => {
    const result = await validatePythonInterpreter('/missing/interpreter');
    expect(result.ok).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.message).toContain('/missing/interpreter');
  });
});
