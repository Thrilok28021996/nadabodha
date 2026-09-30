import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { AppSettings, PythonValidation } from '../shared/ipc';

/**
 * Settings persistence: a single JSON file at
 * <userData>/settings.json. All functions here are Electron-free so they can
 * be unit tested with plain temp files.
 */

export const SETTINGS_FILE_NAME = 'settings.json';
export const DEFAULT_LLM_BASE_URL = 'http://127.0.0.1:1234/v1';

const STRING_KEYS = [
  'pythonPath',
  'llmBaseUrl',
  'llmModel',
  'llmApiKey',
  'dataDir',
  'sttCacheDir',
  'activeModel',
  'watchFolderDir',
] as const;

const BOOLEAN_KEYS = ['summarizationEnabled', 'autoSummarize', 'dictationEnabled', 'dictationPasteEnabled'] as const;

export function settingsFilePath(userDataDir: string): string {
  return path.join(userDataDir, SETTINGS_FILE_NAME);
}

export function defaultSettings(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir()
): AppSettings {
  const hfHome = (env.HF_HOME || '').trim() || path.join(homedir, '.cache', 'huggingface');
  return {
    pythonPath: '',
    llmBaseUrl: DEFAULT_LLM_BASE_URL,
    // Out-of-the-box auto-summarize against LM Studio: this model is loaded
    // and served at 127.0.0.1:1234/v1 (a saved user value still wins —
    // mergeSettings applies on top of these defaults).
    llmModel: 'mistralai/ministral-3-3b',
    llmApiKey: '',
    dataDir: '',
    sttCacheDir: hfHome,
    summarizationEnabled: true,
    autoSummarize: true,
    activeModel: '',
    dictationEnabled: true,
    dictationPasteEnabled: true, // Stage 2: ON by default
    watchFolderDir: '',
  };
}

/**
 * Merges a patch onto a base. Values of the wrong type are ignored so a
 * hand-edited settings.json cannot corrupt the running app.
 */
export function mergeSettings(
  base: AppSettings,
  patch: Partial<Record<keyof AppSettings, unknown>>
): AppSettings {
  const merged: AppSettings = { ...base };
  if (!patch || typeof patch !== 'object') {
    return merged;
  }
  for (const key of STRING_KEYS) {
    const value = patch[key];
    if (typeof value === 'string') {
      merged[key] = value;
    }
  }
  for (const key of BOOLEAN_KEYS) {
    const value = patch[key];
    if (typeof value === 'boolean') {
      merged[key] = value;
    }
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Best-effort preservation of an unreadable settings file. Never throws. */
function backupCorruptFile(filePath: string): void {
  try {
    const backup = `${filePath}.corrupt`;
    fs.rmSync(backup, { force: true });
    fs.renameSync(filePath, backup);
  } catch {
    // Ignore: recovery must not fail because of the backup itself.
  }
}

/**
 * Loads settings from disk. Missing file -> defaults. Unreadable/corrupt
 * content -> corrupt file is moved aside to <path>.corrupt and defaults are
 * returned; this function never throws.
 */
export function loadSettings(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir()
): AppSettings {
  const defaults = defaultSettings(env, homedir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return defaults;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    backupCorruptFile(filePath);
    return defaults;
  }

  if (!isPlainObject(parsed)) {
    backupCorruptFile(filePath);
    return defaults;
  }

  return mergeSettings(defaults, parsed);
}

/** Writes settings atomically (tmp file + rename). Throws on I/O failure. */
export function saveSettings(filePath: string, settings: AppSettings): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export class SettingsStore {
  constructor(
    private readonly filePath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly homedir: string = os.homedir()
  ) {}

  get(): AppSettings {
    return loadSettings(this.filePath, this.env, this.homedir);
  }

  update(patch: Partial<Record<keyof AppSettings, unknown>>): AppSettings {
    const merged = mergeSettings(this.get(), patch);
    saveSettings(this.filePath, merged);
    return merged;
  }
}

/**
 * Interpreter precedence: saved setting -> NADABODHA_PYTHON -> python3.
 */
export function resolvePythonExecutable(
  settings: Pick<AppSettings, 'pythonPath'> | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  const saved = (settings?.pythonPath || '').trim();
  if (saved) {
    return saved;
  }
  const fromEnv = (env.NADABODHA_PYTHON || '').trim();
  if (fromEnv) {
    return fromEnv;
  }
  return 'python3';
}

export interface ProbeResult {
  ok: boolean;
  message: string;
}

export type PythonProbe = (pythonPath: string) => Promise<ProbeResult>;

function describeProbeFailure(stderr: string, stdout: string, fallback: string): string {
  const combined = `${stderr}\n${stdout}`.trim();
  const lines = combined.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return fallback;
  }
  // Prefer the last line: Python reports ModuleNotFoundError there.
  return lines.slice(-2).join(' ');
}

/**
 * Runs `<python> -c "import whisper"` and reports the specific failure.
 */
export function probePythonImport(
  pythonPath: string,
  moduleName = 'whisper',
  timeoutMs = 30000
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(
      pythonPath,
      ['-c', `import ${moduleName}`],
      { timeout: timeoutMs, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, message: `OK — "${moduleName}" imports with ${path.basename(pythonPath)}` });
          return;
        }
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          resolve({ ok: false, message: `Python interpreter not found: ${pythonPath}` });
          return;
        }
        const detail = describeProbeFailure(stderr || '', stdout || '', error.message);
        resolve({ ok: false, message: `Probe failed: ${detail}` });
      }
    );
  });
}

/**
 * Validates an interpreter path. Path problems are blocking (the value must
 * not be saved); a failed import probe is reported inline but still savable
 * so a user can configure an interpreter whose packages install later.
 */
export async function validatePythonInterpreter(
  pythonPath: string,
  probe: PythonProbe = probePythonImport
): Promise<PythonValidation> {
  const trimmed = (pythonPath || '').trim();
  if (!trimmed) {
    return {
      ok: true,
      blocking: false,
      message: 'Not set — using NADABODHA_PYTHON, then python3 from PATH',
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(trimmed);
  } catch {
    return { ok: false, blocking: true, message: `Python interpreter not found: ${trimmed}` };
  }

  if (!stat.isFile()) {
    return { ok: false, blocking: true, message: `Not a file: ${trimmed}` };
  }

  try {
    fs.accessSync(trimmed, fs.constants.X_OK);
  } catch {
    return { ok: false, blocking: true, message: `Not executable: ${trimmed}` };
  }

  const result = await probe(trimmed);
  return { ok: result.ok, blocking: false, message: result.message };
}
