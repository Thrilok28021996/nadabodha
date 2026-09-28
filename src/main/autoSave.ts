import fs from 'fs';
import path from 'path';

/**
 * Auto-save helpers: timestamped transcript/summary files under the user's
 * data directory, plus first-run creation of the data directory layout.
 * Every function returns a result object instead of throwing so an
 * unwritable directory can never take the app down.
 */

export const TRANSCRIPTS_DIR = 'transcripts';
export const SUMMARIES_DIR = 'summaries';
export const SCRIPTS_DIR = 'scripts';
export const PROMPT_TEMPLATE_FILE = 'summarize-prompt.md';

export const DEFAULT_PROMPT_TEMPLATE = `# Summarization prompt

You are a careful assistant summarizing a speech-to-text transcript.
Write in the same language as the transcript.

Produce:
1. A one-paragraph overview.
2. "Key points" as a short bullet list.
3. "Action items" as a bullet list with owners if mentioned (or "-" when unknown).

Do not invent facts. If the transcript is empty or meaningless, say so.

Transcript:
{{transcript}}
`;

export interface SaveFileResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

export interface LayoutResult extends SaveFileResult {
  created?: string[];
  promptPath?: string;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Filesystem-safe timestamp: 2026-09-28_15-30-05 */
export function timestampForDate(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

export function transcriptFilePath(dataDir: string, date: Date = new Date()): string {
  return path.join(dataDir, TRANSCRIPTS_DIR, `transcript_${timestampForDate(date)}.txt`);
}

export function summaryFilePath(dataDir: string, date: Date = new Date()): string {
  return path.join(dataDir, SUMMARIES_DIR, `summary_${timestampForDate(date)}.md`);
}

/** Appends -1, -2, ... when a same-second file already exists. */
export function uniquePath(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return filePath;
  }
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

export function writeTextFile(filePath: string, contents: string): SaveFileResult {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const target = uniquePath(filePath);
    fs.writeFileSync(target, contents, 'utf8');
    return { success: true, filePath: target };
  } catch (err) {
    return { success: false, error: `Cannot write ${filePath}: ${errorMessage(err)}` };
  }
}

export function saveTranscriptToDataDir(
  dataDir: string,
  text: string,
  date: Date = new Date()
): SaveFileResult {
  if (!dataDir || !dataDir.trim()) {
    return { success: false, error: 'No data directory configured' };
  }
  return writeTextFile(transcriptFilePath(dataDir, date), text);
}

export function saveSummaryToDataDir(
  dataDir: string,
  text: string,
  date: Date = new Date()
): SaveFileResult {
  if (!dataDir || !dataDir.trim()) {
    return { success: false, error: 'No data directory configured' };
  }
  return writeTextFile(summaryFilePath(dataDir, date), text);
}

/**
 * Creates <dataDir>/{transcripts,summaries,scripts} and writes the default
 * summarization prompt template on first run.
 */
export function ensureDataDirLayout(dataDir: string): LayoutResult {
  if (!dataDir || !dataDir.trim()) {
    return { success: false, error: 'No data directory chosen' };
  }
  const created: string[] = [];
  try {
    for (const sub of [TRANSCRIPTS_DIR, SUMMARIES_DIR, SCRIPTS_DIR]) {
      const dir = path.join(dataDir, sub);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        created.push(dir);
      }
    }
    const promptPath = path.join(dataDir, SCRIPTS_DIR, PROMPT_TEMPLATE_FILE);
    if (!fs.existsSync(promptPath)) {
      fs.writeFileSync(promptPath, DEFAULT_PROMPT_TEMPLATE, 'utf8');
      created.push(promptPath);
    }
    return { success: true, filePath: dataDir, created, promptPath };
  } catch (err) {
    return {
      success: false,
      error: `Cannot use data directory ${dataDir}: ${errorMessage(err)}`,
    };
  }
}

/**
 * Reads the prompt template from <dataDir>/scripts/, falling back to the
 * built-in default (used before a data directory exists).
 */
export function readPromptTemplate(dataDir: string): { template: string; templatePath?: string } {
  const defaultResult = { template: DEFAULT_PROMPT_TEMPLATE };
  if (!dataDir || !dataDir.trim()) {
    return defaultResult;
  }
  const templatePath = path.join(dataDir, SCRIPTS_DIR, PROMPT_TEMPLATE_FILE);
  try {
    const contents = fs.readFileSync(templatePath, 'utf8');
    if (contents.trim()) {
      return { template: contents, templatePath };
    }
  } catch {
    // Missing template -> fall back to the default.
  }
  return { ...defaultResult, templatePath };
}
