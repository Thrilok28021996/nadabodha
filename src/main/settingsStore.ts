import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { AppSettings, CustomPrompt, PythonValidation } from '../shared/ipc';
import { DEFAULT_PROMPT_TEMPLATE } from './autoSave';

/**
 * Settings persistence: a single JSON file at
 * <userData>/settings.json. All functions here are Electron-free so they can
 * be unit tested with plain temp files.
 */

export const SETTINGS_FILE_NAME = 'settings.json';
export const DEFAULT_LLM_BASE_URL = 'http://127.0.0.1:1234/v1';
export const DEFAULT_RECORDING_SHORTCUT = 'CommandOrControl+Shift+R';

/**
 * Normalizes user-entered accelerator strings (handling symbols, case, aliases)
 * into Electron-compatible accelerator format.
 */
export function normalizeAccelerator(shortcut: string): string {
  let s = (shortcut || '').trim();
  if (!s) return '';
  s = s.replace(/CommandOrControl/gi, 'CommandOrControl');
  s = s.replace(/CmdOrCtrl/gi, 'CommandOrControl');
  s = s.replace(/⌘/g, 'Command+');
  s = s.replace(/⌃/g, 'Control+');
  s = s.replace(/⌥/g, 'Alt+');
  s = s.replace(/⇧/g, 'Shift+');
  const tokens = s.split('+').map((t) => t.trim()).filter(Boolean);
  const normalizedTokens = tokens.map((t) => {
    const lower = t.toLowerCase();
    if (lower === 'cmd' || lower === 'command') return 'Command';
    if (lower === 'ctrl' || lower === 'control') return 'Control';
    if (lower === 'cmdorctrl' || lower === 'commandorcontrol') return 'CommandOrControl';
    if (lower === 'opt' || lower === 'option' || lower === 'alt') return 'Alt';
    if (lower === 'shift') return 'Shift';
    if (lower.length === 1) return lower.toUpperCase();
    if (/^f\d{1,2}$/i.test(lower)) return lower.toUpperCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
  });
  return normalizedTokens.join('+');
}

export const DEFAULT_CUSTOM_PROMPTS: CustomPrompt[] = [
  {
    id: 'general',
    name: 'General Summary',
    description: 'Overview, key points, and action items',
    isBuiltIn: true,
    template: `# Summarization prompt

You are a careful assistant summarizing a speech-to-text transcript.
Write in the same language as the transcript.

Answer with valid Markdown only, using exactly these sections:

## Overview
One paragraph summarizing what was said.

## Key points
- A short bullet list of the most important points.

## Action items
- A bullet list of things to do. Give each item an owner when one was mentioned in the transcript, otherwise write "-".

Rules:
- Do not invent facts: only use what the transcript actually says.
- Keep headings, lists and paragraphs as valid Markdown (## headings, "- " bullets).
- If the transcript is empty or meaningless, say so in the Overview.

Transcript:
{{transcript}}
`,
  },
  {
    id: 'meeting-minutes',
    name: 'Meeting Minutes',
    description: 'Decisions made, discussion points, action items table',
    isBuiltIn: true,
    template: `# Meeting Minutes

You are an assistant recording formal meeting minutes from this transcript.
Write in the same language as the transcript.

Answer with valid Markdown only:

## Meeting Overview & Goals
Brief summary of the meeting context and core purpose.

## Decisions Made
- Key decisions agreed upon by the participants.

## Key Discussion Points
- Significant topics, alternatives considered, and consensus reached.

## Action Items
| Task | Assignee | Deadline / Notes |
| --- | --- | --- |
| Description | Name or "-" | Date or "-" |

## Next Steps
- Follow-ups or topics tabled for future discussion.

Transcript:
{{transcript}}
`,
  },
  {
    id: 'executive-brief',
    name: 'Executive Brief',
    description: 'High-level TL;DR, strategic implications, bottom line',
    isBuiltIn: true,
    template: `# Executive Brief

Provide an executive-level briefing of the following transcript. Be concise, strategic, and direct.

Answer with valid Markdown only:

## Executive Summary (TL;DR)
A 2-3 sentence high-impact summary of what transpired and the key outcome.

## Strategic Implications & Takeaways
- Key impact points
- Risks, opportunities, or trade-offs mentioned

## Bottom Line & Immediate Decisions
- What needs immediate attention, approval, or follow-up.

Transcript:
{{transcript}}
`,
  },
  {
    id: 'action-items',
    name: 'Action Items & Tasks',
    description: 'Extracted task list with assignees, priorities, and deadlines',
    isBuiltIn: true,
    template: `# Action Items & Tasks

Extract all tasks, action items, commitments, and deadlines from this transcript.

Answer with valid Markdown only:

## Immediate / Urgent Tasks
- [ ] Task description — **Owner**: Name (or "-")

## General Action Items
- [ ] Task description — **Owner**: Name (or "-")

## Ideas & Future Considerations
- Items mentioned to look into or explore later.

Transcript:
{{transcript}}
`,
  },
  {
    id: 'clean-notes',
    name: 'Clean Transcript & Notes',
    description: 'Polished prose removing filler words, organized into clear notes',
    isBuiltIn: true,
    template: `# Clean Notes & Polished Transcript

Clean up and structure the following raw speech transcript into clear, professional, well-formatted notes.

Rules:
- Remove filler words (um, uh, like, you know), false starts, and stuttering.
- Fix grammar, punctuation, and capitalization without altering the speaker's original meaning or voice.
- Organize the thoughts into logical paragraphs and bullet points with clear subheadings.
- Preserve any technical terms, names, and numbers accurately.

Transcript:
{{transcript}}
`,
  },
];

const STRING_KEYS = [
  'pythonPath',
  'llmBaseUrl',
  'llmModel',
  'llmApiKey',
  'dataDir',
  'sttCacheDir',
  'activeModel',
  'watchFolderDir',
  'defaultPromptId',
  'recordingShortcut',
] as const;

const BOOLEAN_KEYS = ['summarizationEnabled', 'autoSummarize', 'dictationEnabled', 'dictationPasteEnabled', 'meetingModeEnabled'] as const;

export function settingsFilePath(userDataDir: string): string {
  return path.join(userDataDir, SETTINGS_FILE_NAME);
}

/**
 * Looks for the default 'misc' conda environment python interpreter.
 * Checks known locations where the conda env 'misc' resides.
 */
export function findDefaultMiscPython(homedir: string = os.homedir()): string {
  const candidates = [
    '/Volumes/personal/conda_envs/misc/bin/python3',
    '/Volumes/personal/conda_envs/misc/bin/python',
    path.join(homedir, 'miniconda3', 'envs', 'misc', 'bin', 'python3'),
    path.join(homedir, 'anaconda3', 'envs', 'misc', 'bin', 'python3'),
    path.join(homedir, '.conda', 'envs', 'misc', 'bin', 'python3'),
    path.join(homedir, 'opt', 'anaconda3', 'envs', 'misc', 'bin', 'python3'),
    path.join(homedir, 'opt', 'miniconda3', 'envs', 'misc', 'bin', 'python3'),
    path.join('/opt', 'miniconda3', 'envs', 'misc', 'bin', 'python3'),
    path.join('/opt', 'anaconda3', 'envs', 'misc', 'bin', 'python3'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch { /* ignore */ }
  }
  return '';
}

export function defaultSettings(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir()
): AppSettings {
  const hfHome = (env.HF_HOME || '').trim() || path.join(homedir, '.cache', 'huggingface');
  const miscPython = findDefaultMiscPython(homedir);
  return {
    pythonPath: '',
    defaultPythonPath: miscPython,
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
    meetingModeEnabled: false,
    watchFolderDir: '',
    customPrompts: DEFAULT_CUSTOM_PROMPTS.map((p) => ({ ...p })),
    defaultPromptId: 'general',
    recordingShortcut: DEFAULT_RECORDING_SHORTCUT,
    audioRetentionDays: 90,
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
      merged[key] = value.trim();
    }
  }
  for (const key of BOOLEAN_KEYS) {
    const value = patch[key];
    if (typeof value === 'boolean') {
      merged[key] = value;
    }
  }
  if (Array.isArray(patch.customPrompts)) {
    const validPrompts: CustomPrompt[] = [];
    for (const item of patch.customPrompts) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as CustomPrompt).id === 'string' &&
        (item as CustomPrompt).id.trim() &&
        typeof (item as CustomPrompt).name === 'string' &&
        (item as CustomPrompt).name.trim() &&
        typeof (item as CustomPrompt).template === 'string'
      ) {
        validPrompts.push({
          id: (item as CustomPrompt).id.trim(),
          name: (item as CustomPrompt).name.trim(),
          description: typeof (item as CustomPrompt).description === 'string' ? (item as CustomPrompt).description : undefined,
          template: (item as CustomPrompt).template,
          isBuiltIn: Boolean((item as CustomPrompt).isBuiltIn),
        });
      }
    }
    if (validPrompts.length > 0) {
      merged.customPrompts = validPrompts;
    }
  }
  // Ensure defaultPromptId exists in customPrompts
  if (merged.customPrompts && merged.customPrompts.length > 0) {
    const found = merged.customPrompts.some((p) => p.id === merged.defaultPromptId);
    if (!found) {
      merged.defaultPromptId = merged.customPrompts[0].id;
    }
  }
  // Guarantee recordingShortcut is never empty string
  if (!merged.recordingShortcut) {
    merged.recordingShortcut = DEFAULT_RECORDING_SHORTCUT;
  }
  if (typeof patch.audioRetentionDays === 'number' && Number.isFinite(patch.audioRetentionDays)) {
    merged.audioRetentionDays = Math.max(0, Math.floor(patch.audioRetentionDays));
  } else if (typeof (patch as any).audioRetentionDays === 'string') {
    const parsed = parseInt((patch as any).audioRetentionDays, 10);
    if (!Number.isNaN(parsed)) {
      merged.audioRetentionDays = Math.max(0, parsed);
    }
  }
  return merged;
}

export function resolvePromptTemplate(
  settings: AppSettings,
  promptId?: string
): { id: string; template: string; name: string } {
  const prompts = settings.customPrompts || [];
  const targetId = promptId || settings.defaultPromptId || 'general';

  if (prompts.length > 0) {
    const found = prompts.find((p) => p.id === targetId);
    if (found && found.template && found.template.trim()) {
      return { id: found.id, template: found.template, name: found.name };
    }
    if (promptId && settings.defaultPromptId) {
      const def = prompts.find((p) => p.id === settings.defaultPromptId);
      if (def && def.template && def.template.trim()) {
        return { id: def.id, template: def.template, name: def.name };
      }
    }
    if (prompts[0].template && prompts[0].template.trim()) {
      return { id: prompts[0].id, template: prompts[0].template, name: prompts[0].name };
    }
  }

  return { id: 'general', template: DEFAULT_PROMPT_TEMPLATE, name: 'General Summary' };
}

export function getBuiltInPrompt(id: string): CustomPrompt | undefined {
  return DEFAULT_CUSTOM_PROMPTS.find((p) => p.id === id);
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
    const loaded = loadSettings(this.filePath, this.env, this.homedir);
    if (!loaded.defaultPythonPath) {
      loaded.defaultPythonPath = findDefaultMiscPython(this.homedir);
    }
    return loaded;
  }

  update(patch: Partial<Record<keyof AppSettings, unknown>>): AppSettings {
    const merged = mergeSettings(this.get(), patch);
    saveSettings(this.filePath, merged);
    return merged;
  }
}

/**
 * Interpreter precedence: saved setting -> NADABODHA_PYTHON -> misc conda env -> python3.
 */
export function resolvePythonExecutable(
  settings: Pick<AppSettings, 'pythonPath'> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options?: { miscPython?: string; homedir?: string }
): string {
  const saved = (settings?.pythonPath || '').trim();
  if (saved) {
    return saved;
  }
  const fromEnv = (env.NADABODHA_PYTHON || '').trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (options?.miscPython !== undefined) {
    return options.miscPython || 'python3';
  }
  const misc = findDefaultMiscPython(options?.homedir);
  if (misc) {
    return misc;
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
  probe: PythonProbe = probePythonImport,
  options?: { defaultPython?: string }
): Promise<PythonValidation> {
  const trimmed = (pythonPath || '').trim();
  if (!trimmed) {
    const defaultPath = options?.defaultPython !== undefined ? options.defaultPython : findDefaultMiscPython();
    if (defaultPath) {
      const result = await probe(defaultPath);
      return {
        ok: result.ok,
        blocking: false,
        message: result.ok
          ? `Default (misc) active: ${defaultPath}`
          : `Default (misc): ${defaultPath} (${result.message})`,
      };
    }
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
