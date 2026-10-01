import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Note store: the core data layer for Nadabodha v3.
 *
 * A "note" is one transcription unit — a recording session, imported file,
 * meeting, or dictation day-log.  Each note lives as a subdirectory under the
 * data directory:
 *
 *   <dataDir>/notes/<id>/
 *     note.md        ← frontmatter (YAML) + transcript body
 *     summary.md     ← LLM summary (optional)
 *     audio.*        ← WAV/mp3/... copied from recorder / import (optional)
 *
 * Folder membership is stored in the frontmatter `folder` field so notes
 * survive the user re-arranging files in Finder (the store re-indexes on
 * start rather than relying on directory nesting).
 *
 * The index is kept in memory; it is rebuilt from disk on every
 * `reindex()` call (cheap because notes are small frontmatter reads).
 * Network: none.  HF_HOME: untouched.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NoteSource = 'recording' | 'import' | 'dictation-log' | 'unknown';

export interface NoteFrontmatter {
  id: string;
  title: string;
  created: string; // ISO 8601
  source: NoteSource;
  folder: string;  // '' = Unfiled
  tags?: string[];
  duration: number; // seconds, 0 if unknown
  model: string;   // HF repo id of the model used to transcribe, '' if none
  transcribed_at?: string; // ISO 8601, set after first transcription
  audio?: string;  // basename of the audio file, e.g. 'audio.wav'
  summary_stale?: boolean; // true when re-transcribe ran after last summary
}

export interface NoteRecord {
  id: string;
  title: string;
  created: Date;
  source: NoteSource;
  folder: string;
  tags: string[];
  duration: number;
  model: string;
  transcribed_at?: Date;
  audio?: string;    // absolute path to audio file when present
  noteDir: string;   // absolute path to the note's directory
  noteFile: string;  // absolute path to note.md
  summaryFile: string; // absolute path to summary.md
  summaryStale?: boolean;
}

export interface NoteContent {
  transcript: string;
  summary: string;
  words?: {word: string, start: number, end: number}[];
}

export interface NoteCreateOptions {
  title?: string;
  source: NoteSource;
  folder?: string;
  tags?: string[];
  duration?: number;
  model?: string;
  transcript?: string;
  audioPath?: string; // absolute path to audio to copy into the note dir
  words?: {word: string, start: number, end: number}[];
}

export interface NoteUpdateOptions {
  title?: string;
  folder?: string;
  tags?: string[];
  transcript?: string;
  summary?: string;
  model?: string;
  duration?: number;
  audioPath?: string;
  markSummaryStale?: boolean;
  clearSummaryStale?: boolean;
  words?: {word: string, start: number, end: number}[];
}

export interface NoteStoreResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// Frontmatter serialization
// ---------------------------------------------------------------------------

/**
 * Minimal YAML-like frontmatter: only string/number/boolean scalars and
 * optional values. No library dependency. We write it; we parse it.
 */
function serializeFrontmatter(fm: NoteFrontmatter): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${fm.id}`);
  lines.push(`title: ${yamlString(fm.title)}`);
  lines.push(`created: ${fm.created}`);
  lines.push(`source: ${fm.source}`);
  lines.push(`folder: ${yamlString(fm.folder)}`);
  lines.push(`duration: ${fm.duration}`);
  lines.push(`model: ${yamlString(fm.model)}`);
  if (fm.tags && fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.map((t) => yamlString(t)).join(', ')}]`);
  }
  if (fm.transcribed_at) {
    lines.push(`transcribed_at: ${fm.transcribed_at}`);
  }
  if (fm.audio) {
    lines.push(`audio: ${yamlString(fm.audio)}`);
  }
  if (fm.summary_stale) {
    lines.push(`summary_stale: true`);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

function yamlString(value: string): string {
  // Wrap in double-quotes when the value contains special chars.
  if (/[:#[\]{}&*!|>'"\\%@`\n\r\t]/.test(value) || value.trim() !== value || value === '') {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function parseFrontmatter(raw: string): { fm: Partial<NoteFrontmatter>; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return null;
  }
  const block = match[1];
  const body = match[2] ?? '';
  const fm: Partial<NoteFrontmatter> = {};
  for (const line of block.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : raw;
    switch (key) {
      case 'id':
      case 'title':
      case 'folder':
      case 'model':
      case 'created':
      case 'transcribed_at':
      case 'audio':
        (fm as Record<string, string>)[key] = value;
        break;
      case 'tags': {
        let tagStr = value;
        if (tagStr.startsWith('[') && tagStr.endsWith(']')) {
          tagStr = tagStr.slice(1, -1);
        }
        fm.tags = tagStr
          .split(',')
          .map((t) => t.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        break;
      }
      case 'source':
        fm.source = value as NoteSource;
        break;
      case 'duration':
        fm.duration = parseFloat(value) || 0;
        break;
      case 'summary_stale':
        fm.summary_stale = value === 'true';
        break;
    }
  }
  return { fm, body };
}

// ---------------------------------------------------------------------------
// Tag & Folder extraction helper
// ---------------------------------------------------------------------------

/**
 * Extract tags and determine primary folder from text, title, or source.
 * Extracts hashtags (#meeting, #ideas) and common keywords.
 */
export function extractTagsAndFolder(
  text: string,
  title?: string,
  source?: NoteSource
): { tags: string[]; folder: string } {
  const combined = `${title ?? ''} ${text ?? ''}`;
  const tagsSet = new Set<string>();

  // 1. Extract hashtags: e.g. #meeting, #work, #idea-1
  const hashtagRegex = /#([a-zA-Z0-9_\-]+)/g;
  let match;
  let hashtagFolder = '';
  while ((match = hashtagRegex.exec(combined)) !== null) {
    const rawTag = match[1];
    if (rawTag.length > 0) {
      const normalized = rawTag.charAt(0).toUpperCase() + rawTag.slice(1);
      tagsSet.add(normalized);
      if (!hashtagFolder) {
        hashtagFolder = normalized;
      }
    }
  }

  // 2. Keyword rules for auto-tagging
  const lower = combined.toLowerCase();
  const keywordMap: Array<{ keywords: string[]; tag: string; folder: string }> = [
    { keywords: ['meeting', 'standup', 'sync', 'agenda', 'minutes of the meeting', 'all-hands'], tag: 'Meeting', folder: 'Meetings' },
    { keywords: ['interview', 'candidate', 'resume', 'hiring', 'applicant'], tag: 'Interview', folder: 'Interviews' },
    { keywords: ['lecture', 'class', 'course', 'professor', 'homework', 'syllabus'], tag: 'Lecture', folder: 'Lectures' },
    { keywords: ['brainstorm', 'idea', 'concept', 'proposal'], tag: 'Ideas', folder: 'Ideas' },
    { keywords: ['sprint', 'jira', 'task', 'project', 'deadline', 'client'], tag: 'Work', folder: 'Work' },
    { keywords: ['journal', 'diary', 'personal', 'reflection'], tag: 'Personal', folder: 'Personal' },
  ];

  let detectedFolder = hashtagFolder;

  for (const rule of keywordMap) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      tagsSet.add(rule.tag);
      if (!detectedFolder) {
        detectedFolder = rule.folder;
      }
    }
  }

  if (source === 'dictation-log') {
    tagsSet.add('Dictation');
    if (!detectedFolder) detectedFolder = 'Dictation';
  }

  const tags = Array.from(tagsSet);
  if (!detectedFolder && tags.length > 0) {
    detectedFolder = tags[0];
  }

  return { tags, folder: detectedFolder };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function generateId(): string {
  return crypto.randomUUID();
}

function iso(date: Date = new Date()): string {
  return date.toISOString();
}

const NOTE_MD = 'note.md';
const SUMMARY_MD = 'summary.md';
const NOTES_SUBDIR = 'notes';
const FOLDERS_SUBDIR = 'folders';

// ---------------------------------------------------------------------------
// NoteStore
// ---------------------------------------------------------------------------

export class NoteStore {
  private dataDir: string;
  private notesDir: string;
  private foldersDir: string;
  private index: Map<string, NoteRecord> = new Map();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.notesDir = path.join(dataDir, NOTES_SUBDIR);
    this.foldersDir = path.join(dataDir, FOLDERS_SUBDIR);
  }

  /**
   * Point the store at a (potentially different) data dir and rebuild the
   * in-memory index. Called when the user changes dataDir in settings so the
   * vault follows the setting instead of keeping the boot-time directory.
   */
  setDataDir(dataDir: string): NoteStoreResult<NoteRecord[]> {
    if (dataDir !== this.dataDir) {
      this.dataDir = dataDir;
      this.notesDir = path.join(dataDir, NOTES_SUBDIR);
      this.foldersDir = path.join(dataDir, FOLDERS_SUBDIR);
    }
    return this.reindex();
  }

  /**
   * Ensure the notes and folders directory exist and rebuild the in-memory index from
   * disk. Call once on startup (and after the user changes their data dir).
   * Never throws; errors are logged to stderr.
   */
  reindex(): NoteStoreResult<NoteRecord[]> {
    try {
      fs.mkdirSync(this.notesDir, { recursive: true });
      fs.mkdirSync(this.foldersDir, { recursive: true });
    } catch (err) {
      return { success: false, error: `Cannot create notes or folders dir: ${errorMsg(err)}` };
    }

    const records: NoteRecord[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.notesDir, { withFileTypes: true });
    } catch (err) {
      return { success: false, error: `Cannot read notes dir: ${errorMsg(err)}` };
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const noteDir = path.join(this.notesDir, entry.name);
      const noteFile = path.join(noteDir, NOTE_MD);
      if (!fs.existsSync(noteFile)) continue;

      try {
        const raw = fs.readFileSync(noteFile, 'utf8');
        const parsed = parseFrontmatter(raw);
        if (!parsed) continue;
        const { fm } = parsed;
        if (!fm.id || !fm.created) continue;

        const audioAbs = fm.audio
          ? path.join(noteDir, fm.audio)
          : undefined;

        const record: NoteRecord = {
          id: fm.id,
          title: fm.title || 'Untitled',
          created: new Date(fm.created),
          source: fm.source || 'unknown',
          folder: fm.folder || '',
          tags: fm.tags || [],
          duration: fm.duration || 0,
          model: fm.model || '',
          transcribed_at: fm.transcribed_at ? new Date(fm.transcribed_at) : undefined,
          audio: audioAbs && fs.existsSync(audioAbs) ? audioAbs : undefined,
          noteDir,
          noteFile,
          summaryFile: path.join(noteDir, SUMMARY_MD),
          summaryStale: fm.summary_stale,
        };
        records.push(record);
      } catch {
        // Skip unreadable notes silently.
      }
    }

    // Sort newest-first.
    records.sort((a, b) => b.created.getTime() - a.created.getTime());
    this.index = new Map(records.map((r) => [r.id, r]));
    return { success: true, data: records };
  }

  /** List all notes, newest-first. */
  list(): NoteRecord[] {
    const all = Array.from(this.index.values());
    return all.sort((a, b) => b.created.getTime() - a.created.getTime());
  }

  /** Get a single note by id. */
  get(id: string): NoteRecord | undefined {
    return this.index.get(id);
  }

  /** Unique list of non-empty folder names from index and disk, sorted alphabetically. */
  folders(): string[] {
    const set = new Set<string>();
    // Collect from indexed notes
    for (const r of this.index.values()) {
      if (r.folder) set.add(r.folder);
    }
    // Collect from folders directory on disk
    if (fs.existsSync(this.foldersDir)) {
      try {
        const entries = fs.readdirSync(this.foldersDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            set.add(entry.name);
          }
        }
      } catch (err) {
        console.error(`[NoteStore] Failed to read foldersDir:`, err);
      }
    }
    return Array.from(set).sort();
  }

  /** Count of notes in each folder. */
  folderCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const f of this.folders()) {
      counts[f] = 0;
    }
    for (const r of this.index.values()) {
      const f = r.folder || '';
      counts[f] = (counts[f] || 0) + 1;
    }
    return counts;
  }

  /**
   * Create a folder on disk in folders/ and transcripts/.
   */
  createFolder(name: string): NoteStoreResult<string> {
    const clean = name.trim().replace(/[\\/:*?"<>|]/g, '');
    if (!clean) {
      return { success: false, error: 'Folder name cannot be empty or contain invalid characters' };
    }
    try {
      const folderPath = path.join(this.foldersDir, clean);
      fs.mkdirSync(folderPath, { recursive: true });
      const transcriptsFolderPath = path.join(this.dataDir, 'transcripts', clean);
      fs.mkdirSync(transcriptsFolderPath, { recursive: true });
      return { success: true, data: clean };
    } catch (err) {
      return { success: false, error: `Failed to create folder: ${errorMsg(err)}` };
    }
  }

  /**
   * Delete a folder from disk and move any notes in it to Unfiled.
   */
  deleteFolder(name: string): NoteStoreResult {
    const clean = name.trim();
    if (!clean) {
      return { success: false, error: 'Invalid folder name' };
    }
    try {
      const folderPath = path.join(this.foldersDir, clean);
      if (fs.existsSync(folderPath)) {
        fs.rmSync(folderPath, { recursive: true, force: true });
      }
      // Re-assign all notes in this folder to unfiled ('')
      for (const record of this.index.values()) {
        if (record.folder === clean) {
          this.update(record.id, { folder: '' });
        }
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: `Failed to delete folder: ${errorMsg(err)}` };
    }
  }

  /** Simple full-text search over titles, transcript bodies, folders, and tags. */
  search(query: string): NoteRecord[] {
    if (!query.trim()) return this.list();
    const q = query.toLowerCase();
    const results: NoteRecord[] = [];
    for (const r of this.index.values()) {
      if (
        r.title.toLowerCase().includes(q) ||
        r.folder.toLowerCase().includes(q) ||
        (r.tags && r.tags.some((t) => t.toLowerCase().includes(q)))
      ) {
        results.push(r);
        continue;
      }
      try {
        const raw = fs.readFileSync(r.noteFile, 'utf8');
        const parsed = parseFrontmatter(raw);
        if (parsed && parsed.body.toLowerCase().includes(q)) {
          results.push(r);
        }
      } catch {
        // Skip unreadable notes.
      }
    }
    return results.sort((a, b) => b.created.getTime() - a.created.getTime());
  }

  /** Read the transcript + summary content of a note. */
  readContent(id: string): NoteStoreResult<NoteContent> {
    const record = this.index.get(id);
    if (!record) {
      return { success: false, error: `Note not found: ${id}` };
    }
    try {
      const raw = fs.readFileSync(record.noteFile, 'utf8');
      const parsed = parseFrontmatter(raw);
      const transcript = parsed ? parsed.body.trim() : raw.trim();
      let summary = '';
      if (fs.existsSync(record.summaryFile)) {
        summary = fs.readFileSync(record.summaryFile, 'utf8').trim();
      }
      let words;
      const wordsFile = path.join(record.noteDir, `${record.id}.words.json`);
      if (fs.existsSync(wordsFile)) {
        try {
          words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
        } catch (err) {
          console.error(`[NoteStore] Failed to read words file for note ${id}:`, err);
        }
      }
      return { success: true, data: { transcript, summary, words } };
    } catch (err) {
      return { success: false, error: `Cannot read note: ${errorMsg(err)}` };
    }
  }

  /**
   * Create a new note.
   *
   * If `audioPath` is provided, the audio file is COPIED into the note
   * directory (the original is never moved). The note's `audio` frontmatter
   * field is set to the copied file's basename.
   */
  create(options: NoteCreateOptions): NoteStoreResult<NoteRecord> {
    const id = generateId();
    const now = new Date();
    const noteDir = path.join(this.notesDir, id);
    const noteFile = path.join(noteDir, NOTE_MD);

    try {
      fs.mkdirSync(noteDir, { recursive: true });
    } catch (err) {
      return { success: false, error: `Cannot create note dir: ${errorMsg(err)}` };
    }

    // Copy audio file if provided.
    let audioBasename: string | undefined;
    if (options.audioPath && fs.existsSync(options.audioPath)) {
      try {
        audioBasename = path.basename(options.audioPath);
        const dest = path.join(noteDir, audioBasename);
        fs.copyFileSync(options.audioPath, dest);
      } catch (err) {
        // Audio copy failure is non-fatal: note is still created without it.
        console.error(`[NoteStore] Audio copy failed: ${errorMsg(err)}`);
        audioBasename = undefined;
      }
    }

    let folder = options.folder ?? '';
    let tags = options.tags ? [...options.tags] : [];

    // If tags or folder not specified, auto-detect from content/title
    if (tags.length === 0 || !folder) {
      const auto = extractTagsAndFolder(options.transcript ?? '', options.title, options.source);
      if (tags.length === 0 && auto.tags.length > 0) {
        tags = auto.tags;
      }
      if (!folder && auto.folder) {
        folder = auto.folder;
      }
    }

    // Ensure folder exists on disk if non-empty
    if (folder) {
      try {
        fs.mkdirSync(path.join(this.foldersDir, folder), { recursive: true });
        fs.mkdirSync(path.join(this.dataDir, 'transcripts', folder), { recursive: true });
      } catch (err) {
        console.error(`[NoteStore] Could not create folder directory for ${folder}:`, err);
      }
    }

    const fm: NoteFrontmatter = {
      id,
      title: options.title || defaultTitle(options.source, now),
      created: iso(now),
      source: options.source,
      folder,
      tags: tags.length > 0 ? tags : undefined,
      duration: options.duration || 0,
      model: options.model || '',
      audio: audioBasename,
    };
    if (options.transcript !== undefined) {
      fm.transcribed_at = iso(now);
    }

    const fileContents = serializeFrontmatter(fm) + (options.transcript ?? '');
    try {
      fs.writeFileSync(noteFile, fileContents, 'utf8');
      if (options.words) {
        fs.writeFileSync(path.join(noteDir, `${id}.words.json`), JSON.stringify(options.words), 'utf8');
      }
    } catch (err) {
      return { success: false, error: `Cannot write note: ${errorMsg(err)}` };
    }

    const record: NoteRecord = {
      id,
      title: fm.title,
      created: now,
      source: fm.source,
      folder: fm.folder,
      tags,
      duration: fm.duration,
      model: fm.model,
      transcribed_at: fm.transcribed_at ? new Date(fm.transcribed_at) : undefined,
      audio: audioBasename ? path.join(noteDir, audioBasename) : undefined,
      noteDir,
      noteFile,
      summaryFile: path.join(noteDir, SUMMARY_MD),
    };
    this.index.set(id, record);
    return { success: true, data: record };
  }

  /**
   * Update an existing note's frontmatter and/or transcript.
   * On success the index entry is refreshed.
   */
  update(id: string, options: NoteUpdateOptions): NoteStoreResult<NoteRecord> {
    const record = this.index.get(id);
    if (!record) {
      return { success: false, error: `Note not found: ${id}` };
    }

    try {
      const raw = fs.readFileSync(record.noteFile, 'utf8');
      const parsed = parseFrontmatter(raw);
      if (!parsed) {
        return { success: false, error: 'Cannot parse note frontmatter' };
      }
      const { fm: existingFm } = parsed;
      const body = options.transcript !== undefined ? options.transcript : parsed.body;

      // Copy audio file if provided.
      let audioBasename = existingFm.audio;
      if (options.audioPath && fs.existsSync(options.audioPath)) {
        try {
          audioBasename = path.basename(options.audioPath);
          const dest = path.join(record.noteDir, audioBasename);
          fs.copyFileSync(options.audioPath, dest);
        } catch (err) {
          console.error(`[NoteStore] Audio copy failed: ${errorMsg(err)}`);
        }
      }

      let tags = options.tags !== undefined ? options.tags : (existingFm.tags ?? record.tags ?? []);
      let folder = options.folder !== undefined ? options.folder : (existingFm.folder ?? record.folder ?? '');

      // If user added tags and the note currently has no folder, automatically move note to primary tag's folder
      if (options.tags && options.tags.length > 0 && options.folder === undefined && !folder) {
        folder = options.tags[0];
      }

      // Ensure folder exists on disk if non-empty
      if (folder) {
        try {
          fs.mkdirSync(path.join(this.foldersDir, folder), { recursive: true });
          fs.mkdirSync(path.join(this.dataDir, 'transcripts', folder), { recursive: true });
        } catch (err) {
          console.error(`[NoteStore] Could not create folder directory for ${folder}:`, err);
        }
      }

      // Rebuild frontmatter with updates.
      const fm: NoteFrontmatter = {
        id,
        title: options.title ?? existingFm.title ?? record.title,
        created: existingFm.created ?? iso(record.created),
        source: existingFm.source ?? record.source,
        folder,
        tags: tags.length > 0 ? tags : undefined,
        duration: options.duration ?? existingFm.duration ?? record.duration,
        model: options.model ?? existingFm.model ?? record.model,
        transcribed_at: options.transcript !== undefined ? iso() : existingFm.transcribed_at,
        audio: audioBasename,
        summary_stale: options.markSummaryStale
          ? true
          : options.clearSummaryStale
          ? undefined
          : existingFm.summary_stale,
      };

      fs.writeFileSync(record.noteFile, serializeFrontmatter(fm) + body, 'utf8');

      if (options.summary !== undefined) {
        fs.writeFileSync(record.summaryFile, options.summary, 'utf8');
      }
      
      if (options.words !== undefined) {
        fs.writeFileSync(path.join(record.noteDir, `${id}.words.json`), JSON.stringify(options.words), 'utf8');
      }

      // Refresh in-memory record.
      const updated: NoteRecord = {
        ...record,
        title: fm.title,
        folder: fm.folder,
        tags,
        duration: fm.duration,
        model: fm.model,
        transcribed_at: fm.transcribed_at ? new Date(fm.transcribed_at) : undefined,
        audio: audioBasename ? path.join(record.noteDir, audioBasename) : undefined,
        summaryStale: fm.summary_stale,
      };
      this.index.set(id, updated);
      return { success: true, data: updated };
    } catch (err) {
      return { success: false, error: `Cannot update note: ${errorMsg(err)}` };
    }
  }

  /**
   * Delete a note and its directory.  Logs a warning but succeeds even if
   * the directory is already gone.
   */
  delete(id: string): NoteStoreResult {
    const record = this.index.get(id);
    if (!record) {
      return { success: false, error: `Note not found: ${id}` };
    }
    try {
      fs.rmSync(record.noteDir, { recursive: true, force: true });
    } catch (err) {
      return { success: false, error: `Cannot delete note: ${errorMsg(err)}` };
    }
    this.index.delete(id);
    return { success: true };
  }

  /**
   * Delete audio recording files older than `retentionDays`.
   * IMPORTANT: Note markdown files (note.md, summary.md, transcripts, words, metadata)
   * are NEVER deleted — only the large audio recordings on disk are removed.
   */
  deleteOldAudioRecordings(retentionDays: number): { deletedCount: number; freedBytes: number } {
    if (!retentionDays || retentionDays <= 0) {
      return { deletedCount: 0, freedBytes: 0 };
    }
    const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;
    let freedBytes = 0;

    for (const record of this.index.values()) {
      if (record.created.getTime() < cutoffTime) {
        let noteModified = false;

        // 1. Delete audio referenced in record
        if (record.audio && fs.existsSync(record.audio)) {
          try {
            const stat = fs.statSync(record.audio);
            freedBytes += stat.size;
            fs.unlinkSync(record.audio);
            deletedCount += 1;
            noteModified = true;
          } catch (err) {
            console.error(`[NoteStore] Failed to delete audio for note ${record.id}:`, err);
          }
        }

        // 2. Also check noteDir for any audio files (*.wav, *.mp3, *.m4a, *.ogg, *.flac)
        if (fs.existsSync(record.noteDir)) {
          try {
            const files = fs.readdirSync(record.noteDir);
            for (const file of files) {
              if (/\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(file)) {
                const filePath = path.join(record.noteDir, file);
                try {
                  const stat = fs.statSync(filePath);
                  freedBytes += stat.size;
                  fs.unlinkSync(filePath);
                  deletedCount += 1;
                  noteModified = true;
                } catch { /* skip */ }
              }
            }
          } catch { /* skip */ }
        }

        if (noteModified) {
          record.audio = undefined;
          // Update frontmatter on disk to clear audio field, preserving note.md content
          try {
            const raw = fs.readFileSync(record.noteFile, 'utf8');
            const parsed = parseFrontmatter(raw);
            if (parsed && parsed.fm) {
              parsed.fm.audio = undefined;
              const newFrontmatter = serializeFrontmatter(parsed.fm as NoteFrontmatter);
              fs.writeFileSync(record.noteFile, newFrontmatter + parsed.body, 'utf8');
            }
          } catch (err) {
            console.error(`[NoteStore] Failed to update frontmatter for note ${record.id}:`, err);
          }
        }
      }
    }

    return { deletedCount, freedBytes };
  }

  /**
   * One-time migration: import existing transcript/ and summary/ files into
   * notes.  Additive only — never deletes the originals.
   *
   * This runs on first startup with a data directory that has the old layout
   * but no notes/ subdirectory yet.
   */
  migrateFromLegacy(): NoteStoreResult<number> {
    const transcriptsDir = path.join(this.dataDir, 'transcripts');
    if (!fs.existsSync(transcriptsDir)) {
      return { success: true, data: 0 };
    }

    let migrated = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(transcriptsDir, { withFileTypes: true });
    } catch {
      return { success: true, data: 0 };
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(txt|md)$/.test(entry.name)) continue;

      const transcriptPath = path.join(transcriptsDir, entry.name);
      let transcript = '';
      try {
        transcript = fs.readFileSync(transcriptPath, 'utf8');
      } catch {
        continue;
      }

      // Derive date from filename (transcript_2026-09-28_15-30-05.txt).
      const dateMatch = entry.name.match(/(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/);
      const created = dateMatch
        ? new Date(`${dateMatch[1]}T${dateMatch[2].replace(/-/g, ':')}`)
        : new Date();

      // Look for a matching summary.
      const summaryBase = entry.name.replace(/^transcript/, 'summary').replace(/\.txt$/, '.md');
      const summaryPath = path.join(this.dataDir, 'summaries', summaryBase);
      let summary: string | undefined;
      if (fs.existsSync(summaryPath)) {
        try {
          summary = fs.readFileSync(summaryPath, 'utf8');
        } catch {
          // Summary read failure is non-fatal.
        }
      }

      const title = `Migrated — ${created.toLocaleDateString()}`;
      const result = this.create({
        title,
        source: 'import',
        transcript,
      });
      if (result.success && result.data && summary) {
        this.update(result.data.id, { summary });
      }
      migrated += 1;
    }

    return { success: true, data: migrated };
  }
}

function defaultTitle(source: NoteSource, date: Date): string {
  const d = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  switch (source) {
    case 'recording':
      return `Recording — ${d}`;
    case 'import':
      return `Import — ${d}`;
    case 'dictation-log':
      return `Dictation — ${d}`;
    default:
      return `Note — ${d}`;
  }
}
