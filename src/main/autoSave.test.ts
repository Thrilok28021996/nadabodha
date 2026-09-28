import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_PROMPT_TEMPLATE,
  PROMPT_TEMPLATE_FILE,
  SCRIPTS_DIR,
  SUMMARIES_DIR,
  TRANSCRIPTS_DIR,
  ensureDataDirLayout,
  readPromptTemplate,
  saveSummaryToDataDir,
  saveTranscriptToDataDir,
  summaryFilePath,
  timestampForDate,
  transcriptFilePath,
  uniquePath,
  writeTextFile,
} from './autoSave';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nadabodha-autosave-'));
}

describe('timestamp + path logic', () => {
  const date = new Date(2026, 8, 28, 15, 4, 5); // 2026-09-28 15:04:05 local

  it('produces a filesystem-safe timestamp', () => {
    expect(timestampForDate(date)).toBe('2026-09-28_15-04-05');
    const padded = new Date(2026, 0, 2, 3, 7, 9);
    expect(timestampForDate(padded)).toBe('2026-01-02_03-07-09');
  });

  it('builds transcript paths under transcripts/ as .txt', () => {
    const p = transcriptFilePath('/data', date);
    expect(p).toBe(path.join('/data', TRANSCRIPTS_DIR, 'transcript_2026-09-28_15-04-05.txt'));
  });

  it('builds summary paths under summaries/ as .md', () => {
    const p = summaryFilePath('/data', date);
    expect(p).toBe(path.join('/data', SUMMARIES_DIR, 'summary_2026-09-28_15-04-05.md'));
  });

  it('avoids clobbering a same-second file', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'transcript_2026-09-28_15-04-05.txt');
    fs.writeFileSync(file, 'first');
    expect(uniquePath(file)).toBe(path.join(dir, 'transcript_2026-09-28_15-04-05-1.txt'));
    fs.writeFileSync(path.join(dir, 'transcript_2026-09-28_15-04-05-1.txt'), 'second');
    expect(uniquePath(file)).toBe(path.join(dir, 'transcript_2026-09-28_15-04-05-2.txt'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('writeTextFile / auto-save', () => {
  it('writes transcript and summary files into the data dir', () => {
    const dir = tmpDir();
    const transcript = saveTranscriptToDataDir(dir, 'hello transcript', new Date(2026, 8, 28, 15, 4, 5));
    expect(transcript.success).toBe(true);
    expect(fs.readFileSync(transcript.filePath as string, 'utf8')).toBe('hello transcript');
    expect(path.basename(transcript.filePath as string)).toBe('transcript_2026-09-28_15-04-05.txt');

    const summary = saveSummaryToDataDir(dir, '# Summary', new Date(2026, 8, 28, 15, 4, 5));
    expect(summary.success).toBe(true);
    expect(fs.readFileSync(summary.filePath as string, 'utf8')).toBe('# Summary');
    expect(path.basename(summary.filePath as string)).toBe('summary_2026-09-28_15-04-05.md');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports an error when no data directory is configured', () => {
    expect(saveTranscriptToDataDir('', 'x').success).toBe(false);
    expect(saveSummaryToDataDir('   ', 'x').success).toBe(false);
    expect(saveTranscriptToDataDir('', 'x').error).toContain('No data directory');
  });

  it('never throws for an unwritable path', () => {
    const dir = tmpDir();
    const blockingFile = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blockingFile, 'x');
    const result = writeTextFile(path.join(blockingFile, 'sub', 'file.txt'), 'data');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot write');
    expect(() => writeTextFile('/proc/definitely/not/writable/x.txt', 'data')).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ensureDataDirLayout', () => {
  it('creates transcripts/summaries/scripts and the prompt template once', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'nadabodha-data');

    const first = ensureDataDirLayout(target);
    expect(first.success).toBe(true);
    expect(fs.existsSync(path.join(target, TRANSCRIPTS_DIR))).toBe(true);
    expect(fs.existsSync(path.join(target, SUMMARIES_DIR))).toBe(true);
    expect(fs.existsSync(path.join(target, SCRIPTS_DIR))).toBe(true);
    const promptPath = path.join(target, SCRIPTS_DIR, PROMPT_TEMPLATE_FILE);
    expect(fs.existsSync(promptPath)).toBe(true);
    expect(fs.readFileSync(promptPath, 'utf8')).toBe(DEFAULT_PROMPT_TEMPLATE);

    // second run is idempotent and keeps an edited template
    fs.writeFileSync(promptPath, 'custom prompt {{transcript}}', 'utf8');
    const second = ensureDataDirLayout(target);
    expect(second.success).toBe(true);
    expect(fs.readFileSync(promptPath, 'utf8')).toBe('custom prompt {{transcript}}');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns a clear error for an unusable directory', () => {
    const dir = tmpDir();
    const blockingFile = path.join(dir, 'file.txt');
    fs.writeFileSync(blockingFile, 'x');
    const result = ensureDataDirLayout(path.join(blockingFile, 'child'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot use data directory');
    expect(ensureDataDirLayout('').success).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('readPromptTemplate', () => {
  it('uses the built-in default without a data directory', () => {
    expect(readPromptTemplate('').template).toBe(DEFAULT_PROMPT_TEMPLATE);
    expect(readPromptTemplate('').template).toContain('{{transcript}}');
  });

  it('reads a custom template from the data directory', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'data');
    ensureDataDirLayout(target);
    const promptPath = path.join(target, SCRIPTS_DIR, PROMPT_TEMPLATE_FILE);
    fs.writeFileSync(promptPath, 'Custom: {{transcript}}', 'utf8');

    const result = readPromptTemplate(target);
    expect(result.template).toBe('Custom: {{transcript}}');
    expect(result.templatePath).toBe(promptPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the default when the template is missing', () => {
    const dir = tmpDir();
    const result = readPromptTemplate(dir);
    expect(result.template).toBe(DEFAULT_PROMPT_TEMPLATE);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
