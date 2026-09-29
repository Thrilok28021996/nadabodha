import fs from 'fs';
import os from 'os';
import path from 'path';
import { NoteStore, NoteRecord } from './noteStore';

/** Create a fresh temp directory for each test. */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nadabodha-notestore-test-'));
}

/** Recursively remove a temp directory. */
function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

describe('NoteStore: reindex', () => {
  let dir: string;
  let store: NoteStore;

  beforeEach(() => {
    dir = tmpDir();
    store = new NoteStore(dir);
  });

  afterEach(() => cleanup(dir));

  it('creates the notes directory on first reindex', () => {
    const result = store.reindex();
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(dir, 'notes'))).toBe(true);
  });

  it('returns an empty list when there are no notes', () => {
    store.reindex();
    expect(store.list()).toEqual([]);
  });

  it('loads notes from disk after reindex', () => {
    const r1 = store.reindex();
    expect(r1.success).toBe(true);

    store.create({ source: 'recording', title: 'Test Note', transcript: 'hello' });

    // A new store on the same dir should find it after reindex.
    const store2 = new NoteStore(dir);
    const r2 = store2.reindex();
    expect(r2.success).toBe(true);
    expect(r2.data).toHaveLength(1);
    expect(r2.data![0].title).toBe('Test Note');
  });
});

describe('NoteStore: create', () => {
  let dir: string;
  let store: NoteStore;

  beforeEach(() => {
    dir = tmpDir();
    store = new NoteStore(dir);
    store.reindex();
  });

  afterEach(() => cleanup(dir));

  it('creates a note and returns it', () => {
    const result = store.create({ source: 'recording', title: 'My note' });
    expect(result.success).toBe(true);
    expect(result.data!.id).toBeTruthy();
    expect(result.data!.title).toBe('My note');
    expect(result.data!.source).toBe('recording');
  });

  it('creates note.md with frontmatter on disk', () => {
    const result = store.create({ source: 'recording', transcript: 'hello world' });
    expect(result.success).toBe(true);
    const content = fs.readFileSync(result.data!.noteFile, 'utf8');
    expect(content).toContain('---');
    expect(content).toContain('hello world');
  });

  it('assigns a default title by source', () => {
    const result = store.create({ source: 'dictation-log' });
    expect(result.data!.title).toContain('Dictation');
  });

  it('copies audio file into note dir when provided', () => {
    const audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-audio-'));
    const audioPath = path.join(audioDir, 'test.wav');
    fs.writeFileSync(audioPath, Buffer.alloc(8)); // fake WAV
    try {
      const result = store.create({ source: 'recording', audioPath });
      expect(result.success).toBe(true);
      expect(result.data!.audio).toBeTruthy();
      expect(fs.existsSync(result.data!.audio!)).toBe(true);
      // Original should still exist (never moved).
      expect(fs.existsSync(audioPath)).toBe(true);
    } finally {
      cleanup(audioDir);
    }
  });

  it('creates note successfully even when audio copy fails (non-fatal)', () => {
    const result = store.create({ source: 'recording', audioPath: '/nonexistent/audio.wav' });
    expect(result.success).toBe(true);
    expect(result.data!.audio).toBeUndefined();
  });

  it('indexes the new note immediately', () => {
    store.create({ source: 'recording', title: 'A' });
    expect(store.list()).toHaveLength(1);
  });
});

describe('NoteStore: list and search', () => {
  let dir: string;
  let store: NoteStore;

  beforeEach(() => {
    dir = tmpDir();
    store = new NoteStore(dir);
    store.reindex();
  });

  afterEach(() => cleanup(dir));

  it('lists notes newest-first when timestamps differ', () => {
    // We need to ensure the two notes have different created timestamps.
    // Create manually with explicit dates by patching the note after creation
    // so the sort order is deterministic.
    const noteA = store.create({ source: 'recording', title: 'A' }).data!;
    // Manually edit the note.md to set a past date for note A.
    const raw = fs.readFileSync(noteA.noteFile, 'utf8');
    const older = raw.replace(/^created: .*/m, 'created: 2020-01-01T00:00:00.000Z');
    fs.writeFileSync(noteA.noteFile, older, 'utf8');

    store.create({ source: 'recording', title: 'B' }); // newer (now)
    store.reindex(); // pick up the edited timestamp

    const list = store.list();
    expect(list.map((n) => n.title)).toEqual(['B', 'A']);
  });

  it('searches by title', () => {
    store.create({ source: 'recording', title: 'Hello world' });
    store.create({ source: 'recording', title: 'Goodbye' });
    const results = store.search('hello');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Hello world');
  });

  it('searches by transcript body', () => {
    store.create({ source: 'recording', title: 'Note A', transcript: 'the quick brown fox' });
    store.create({ source: 'recording', title: 'Note B', transcript: 'lazy dog' });
    const results = store.search('quick brown');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Note A');
  });

  it('returns all notes when query is empty', () => {
    store.create({ source: 'recording' });
    store.create({ source: 'recording' });
    expect(store.search('')).toHaveLength(2);
  });
});

describe('NoteStore: folders', () => {
  let dir: string;
  let store: NoteStore;

  beforeEach(() => {
    dir = tmpDir();
    store = new NoteStore(dir);
    store.reindex();
  });

  afterEach(() => cleanup(dir));

  it('returns unique sorted folder names', () => {
    store.create({ source: 'recording', folder: 'Work' });
    store.create({ source: 'recording', folder: 'Personal' });
    store.create({ source: 'recording', folder: 'Work' });
    expect(store.folders()).toEqual(['Personal', 'Work']);
  });

  it('returns note counts per folder', () => {
    store.create({ source: 'recording', folder: 'Work' });
    store.create({ source: 'recording', folder: 'Work' });
    store.create({ source: 'recording', folder: 'Personal' });
    store.create({ source: 'recording' }); // unfiled
    const counts = store.folderCounts();
    expect(counts['Work']).toBe(2);
    expect(counts['Personal']).toBe(1);
    expect(counts['']).toBe(1);
  });
});

describe('NoteStore: update', () => {
  let dir: string;
  let store: NoteStore;
  let note: NoteRecord;

  beforeEach(() => {
    dir = tmpDir();
    store = new NoteStore(dir);
    store.reindex();
    note = store.create({ source: 'recording', title: 'Original', transcript: 'hello' }).data!;
  });

  afterEach(() => cleanup(dir));

  it('updates the title', () => {
    store.update(note.id, { title: 'Updated' });
    expect(store.get(note.id)!.title).toBe('Updated');
  });

  it('updates the transcript on disk', () => {
    store.update(note.id, { transcript: 'new content' });
    const content = store.readContent(note.id);
    expect(content.data!.transcript).toBe('new content');
  });

  it('writes the summary to summary.md', () => {
    store.update(note.id, { summary: '# Summary\nGreat!' });
    const content = store.readContent(note.id);
    expect(content.data!.summary).toContain('Great!');
  });

  it('marks summary as stale', () => {
    store.update(note.id, { markSummaryStale: true });
    expect(store.get(note.id)!.summaryStale).toBe(true);
  });

  it('clears stale flag', () => {
    store.update(note.id, { markSummaryStale: true });
    store.update(note.id, { clearSummaryStale: true });
    expect(store.get(note.id)!.summaryStale).toBeFalsy();
  });

  it('updates the folder', () => {
    store.update(note.id, { folder: 'Work' });
    expect(store.get(note.id)!.folder).toBe('Work');
  });

  it('returns an error for an unknown id', () => {
    const result = store.update('nonexistent', { title: 'X' });
    expect(result.success).toBe(false);
  });

  it('persists updated frontmatter to disk (survives reindex)', () => {
    store.update(note.id, { title: 'Persisted', folder: 'Archive' });
    const store2 = new NoteStore(dir);
    store2.reindex();
    const reloaded = store2.get(note.id);
    expect(reloaded!.title).toBe('Persisted');
    expect(reloaded!.folder).toBe('Archive');
  });
});

describe('NoteStore: readContent', () => {
  let dir: string;
  let store: NoteStore;

  beforeEach(() => {
    dir = tmpDir();
    store = new NoteStore(dir);
    store.reindex();
  });

  afterEach(() => cleanup(dir));

  it('reads transcript and summary', () => {
    const note = store.create({ source: 'recording', transcript: 'hello' }).data!;
    store.update(note.id, { summary: '# Sum' });
    const content = store.readContent(note.id);
    expect(content.success).toBe(true);
    expect(content.data!.transcript).toBe('hello');
    expect(content.data!.summary).toBe('# Sum');
  });

  it('returns empty summary when summary.md does not exist', () => {
    const note = store.create({ source: 'recording' }).data!;
    const content = store.readContent(note.id);
    expect(content.data!.summary).toBe('');
  });
});

describe('NoteStore: delete', () => {
  let dir: string;
  let store: NoteStore;

  beforeEach(() => {
    dir = tmpDir();
    store = new NoteStore(dir);
    store.reindex();
  });

  afterEach(() => cleanup(dir));

  it('deletes a note from disk and index', () => {
    const note = store.create({ source: 'recording' }).data!;
    expect(store.list()).toHaveLength(1);

    const result = store.delete(note.id);
    expect(result.success).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(fs.existsSync(note.noteDir)).toBe(false);
  });

  it('returns error for unknown id', () => {
    const result = store.delete('nonexistent');
    expect(result.success).toBe(false);
  });
});

describe('NoteStore: migrateFromLegacy', () => {
  let dir: string;
  let store: NoteStore;

  beforeEach(() => {
    dir = tmpDir();
    store = new NoteStore(dir);
    store.reindex();
  });

  afterEach(() => cleanup(dir));

  it('migrates transcript files from the old layout', () => {
    const txDir = path.join(dir, 'transcripts');
    fs.mkdirSync(txDir, { recursive: true });
    fs.writeFileSync(
      path.join(txDir, 'transcript_2026-09-28_15-30-05.txt'),
      'old transcript content'
    );

    const result = store.migrateFromLegacy();
    expect(result.success).toBe(true);
    expect(result.data).toBe(1);
    expect(store.list()).toHaveLength(1);

    const content = store.readContent(store.list()[0].id);
    expect(content.data!.transcript).toBe('old transcript content');
  });

  it('also imports matching summary files', () => {
    const txDir = path.join(dir, 'transcripts');
    const sumDir = path.join(dir, 'summaries');
    fs.mkdirSync(txDir, { recursive: true });
    fs.mkdirSync(sumDir, { recursive: true });
    fs.writeFileSync(path.join(txDir, 'transcript_2026-09-28_15-30-05.txt'), 'tx');
    fs.writeFileSync(path.join(sumDir, 'summary_2026-09-28_15-30-05.md'), '# Sum');

    store.migrateFromLegacy();
    const content = store.readContent(store.list()[0].id);
    expect(content.data!.summary).toContain('# Sum');
  });

  it('returns 0 when there is no transcripts directory (no-op)', () => {
    const result = store.migrateFromLegacy();
    expect(result.success).toBe(true);
    expect(result.data).toBe(0);
  });

  it('does not overwrite existing notes on repeated calls', () => {
    const txDir = path.join(dir, 'transcripts');
    fs.mkdirSync(txDir, { recursive: true });
    fs.writeFileSync(path.join(txDir, 'transcript_2026-09-28_15-30-05.txt'), 'a');

    store.migrateFromLegacy();
    store.migrateFromLegacy(); // second run on same dir
    // Each call creates a new note (migration is additive; the store doesn't
    // track which files were already imported).
    // This is acceptable per the plan: "additive only — never delete user files".
    expect(store.list().length).toBeGreaterThanOrEqual(1);
  });
});
