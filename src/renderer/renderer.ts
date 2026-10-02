/**
 * Nadabodha v3 renderer — Steno-style UI
 *
 * Architecture:
 *   - Left sidebar: search, primary actions, dictation strip, folder nav,
 *     recent-notes list
 *   - Right main: note-detail (title, tabs, recording pill, settings slide-over)
 *
 * All existing element IDs are preserved or explicitly updated together with
 * the harness (check-ids.js).  Vendored libraries (DOMPurify, marked) are
 * loaded via the copy-assets script and accessed through window globals.
 *
 * This file is loaded by index.html as a classic <script>, NOT as a module:
 * it must contain no top-level import/export. TypeScript would otherwise emit
 * the CommonJS `Object.defineProperty(exports, ...)` prologue and `exports` is
 * undefined in the page, which aborts the whole script before a single
 * listener is registered (D8 root cause: settings/banner/hint went dead).
 */

// ---------------------------------------------------------------------------
// Vendored library types (set by copy-assets.js, loaded before this script)
// ---------------------------------------------------------------------------

declare const DOMPurify: {
  sanitize(input: string, config?: Record<string, unknown>): string;
  addHook(name: string, fn: (node: Element) => void): void;
};
declare const marked: { parse(src: string): string | Promise<string> };

// ---------------------------------------------------------------------------
// Electron API
// ---------------------------------------------------------------------------

interface ImportItem {
  id: string;
  filePath: string;
  progress: number;
  status: "pending" | "transcribing" | "completed" | "error" | "cancelled";
  error?: string;
  text?: string;
}

interface NoteInfo {
  id: string;
  title: string;
  created: string;
  source: 'recording' | 'import' | 'dictation-log' | 'unknown';
  folder: string;
  tags?: string[];
  duration: number;
  model: string;
  transcribed_at?: string;
  hasAudio: boolean;
  summaryStale?: boolean;
}

interface NoteContent { transcript: string; summary: string; words?: {word: string, start: number, end: number}[]; }
interface NoteListResult { notes: NoteInfo[]; folders: string[]; folderCounts: Record<string, number>; error?: string; }
interface TranscriptionEvent {
  status: string;
  text?: string;
  progress?: number;
  error?: string;
  origin?: string;
  dictationNotice?: string;
  savedTranscriptPath?: string;
  savedSummaryPath?: string;
  saveError?: string;
  partial?: boolean;
  file?: string;
  bytesDone?: number;
  bytesTotal?: number;
  tags?: string[];
  /** D3: system-audio (catap) capture failed; the mic recording continues. */
  meetingError?: string;
  /** D4: run token — completion routing prefers this over the local slot. */
  reTranscribeNoteId?: string;
  reTranscribeRunId?: number;
}
interface AppSettings {
  pythonPath: string;
  defaultPythonPath?: string;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  dataDir: string;
  sttCacheDir: string;
  summarizationEnabled: boolean;
  autoSummarize: boolean;
  activeModel: string;
  dictationEnabled: boolean;
  dictationPasteEnabled?: boolean;
  meetingModeEnabled?: boolean;
  watchFolderDir?: string;
  customPrompts?: CustomPrompt[];
  defaultPromptId?: string;
  recordingShortcut?: string;
  audioRetentionDays?: number;
}
interface CustomPrompt {
  id: string;
  name: string;
  description?: string;
  template: string;
  isBuiltIn?: boolean;
}
interface DictationStatusInfo { supported: boolean; enabled: boolean; accessibilityTrusted: boolean; running: boolean; reason?: string; }
interface HfModelInfo { id: string; downloads: number; pipelineTag: string | null; tags: string[]; kind: string; reason?: string; format: string; }
interface HfModelListResult { models: HfModelInfo[]; installed: string[]; partial?: string[]; activeModel: string; error?: string; }
interface LlmConnectionResult { ok: boolean; models: string[]; message: string; }
interface PythonValidation { ok: boolean; blocking: boolean; message: string; }
interface SettingsUpdateResult { settings: AppSettings; errors: Partial<Record<string, string>>; messages?: Partial<Record<string, string>>; }

// Script-file global augmentation (this file is a classic script, not a
// module — see the header comment). False-positive disable: the interface
// merges with the DOM lib's Window, so the name is "used" by lib.dom.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Window {
  electronAPI: ElectronAPI;
  /** Set once init() has fully registered its listeners (harness tripwire). */
  __nadabodhaReady?: boolean;
}

interface ElectronAPI {
  startRecording(options?: { meetingMode?: boolean }): Promise<{ outputPath: string | null; error?: string }>;
  stopRecording(): Promise<{ outputPath: string | null }>;
  importAudio(fp: string): Promise<{ filePath: string }>;
  cancelTranscription(): Promise<{ cancelled: boolean }>;
  saveTranscript(req: { filePath: string; text: string; format?: 'txt' | 'srt' | 'vtt'; words?: {word: string, start: number, end: number}[] }): Promise<{ success: boolean; filePath?: string; error?: string }>;
  copyTranscript(text: string): Promise<{ copied: boolean }>;
  requestStatus(): Promise<{ status: string; text: string; filePath: string | null }>;
  requestSavePath(): Promise<string | undefined>;
  onTranscriptionEvent(cb: (e: TranscriptionEvent) => void): void;
  removeTranscriptionListener(): void;
  enqueueImports(paths: string[]): Promise<string[]>;
  pickWatchFolder(): Promise<string | null>;
  cancelImportItem(id: string): Promise<{cancelled: boolean}>;
  onImportQueueEvent(cb: (queue: ImportItem[]) => void): void;
  removeImportQueueListener?(): void;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<SettingsUpdateResult>;
  validatePython(path: string): Promise<PythonValidation>;
  pickDirectory(title?: string): Promise<string | null>;
  pickPythonFile(): Promise<string | null>;
  getPathForFile?(file: File): string;
  testLlmConnection(url?: string): Promise<LlmConnectionResult>;
  listHfModels(q?: string): Promise<HfModelListResult>;
  downloadModel(id: string): Promise<{ started: boolean; error?: string }>;
  cancelDownload(): Promise<{ cancelled: boolean }>;
  summarize(opts?: { text?: string; promptId?: string; template?: string } | string): Promise<{ started: boolean; error?: string }>;
  cancelSummary(): Promise<{ cancelled: boolean }>;
  getDictationStatus(): Promise<DictationStatusInfo>;
  requestDictationAccess(): Promise<DictationStatusInfo>;
  listNotes(): Promise<NoteListResult>;
  getNote(id: string): Promise<{ note?: NoteInfo; content?: NoteContent; error?: string }>;
  createNote(req: { title?: string; source: string; folder?: string; tags?: string[]; transcript?: string; audioPath?: string; words?: {word: string, start: number, end: number}[] }): Promise<{ success: boolean; note?: NoteInfo; error?: string }>;
  updateNote(req: { id: string; title?: string; folder?: string; tags?: string[]; transcript?: string; summary?: string; model?: string; audioPath?: string; markSummaryStale?: boolean; clearSummaryStale?: boolean; words?: {word: string, start: number, end: number}[] }): Promise<{ success: boolean; note?: NoteInfo; error?: string }>;
  deleteNote(id: string): Promise<{ success: boolean; error?: string }>;
  readNoteContent(id: string): Promise<{ note?: NoteInfo; content?: NoteContent; error?: string }>;
  listFolders(): Promise<{ folders: string[]; counts: Record<string, number> }>;
  createFolder(name: string): Promise<{ success: boolean; data?: string; error?: string }>;
  deleteFolder(name: string): Promise<{ success: boolean; error?: string }>;
  searchNotes(q: string): Promise<NoteListResult>;
  reTranscribe(noteId: string): Promise<{ started: boolean; error?: string; runId?: number }>;
  onToggleRecording?(cb: () => void): () => void;
  cleanOldAudio(days?: number): Promise<{ success: boolean; deletedCount: number; freedBytes: number; error?: string }>;
}

const api = window.electronAPI;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

// Sidebar
const searchInput       = document.getElementById('searchInput') as HTMLInputElement;
const searchClearBtn    = document.getElementById('searchClearBtn') as HTMLButtonElement;
const recordBtn         = document.getElementById('recordBtn') as HTMLButtonElement;
const importBtn         = document.getElementById('importBtn') as HTMLButtonElement;
const navHome           = document.getElementById('navHome') as HTMLButtonElement;
const navAll            = document.getElementById('navAll') as HTMLButtonElement;
const navDictation      = document.getElementById('navDictation') as HTMLButtonElement;
const allCount          = document.getElementById('allCount') as HTMLSpanElement;
const folderList        = document.getElementById('folderList') as HTMLUListElement;
const addFolderBtn      = document.getElementById('addFolderBtn') as HTMLButtonElement;
const noteList          = document.getElementById('noteList') as HTMLUListElement;
const noteListEmpty     = document.getElementById('noteListEmpty') as HTMLParagraphElement;
const notesListLabel    = document.getElementById('notesListLabel') as HTMLSpanElement;
const importQueueSection = document.getElementById('importQueueSection') as HTMLElement;
const importQueueList   = document.getElementById('importQueueList') as HTMLElement;
const settingsBtn       = document.getElementById('settingsBtn') as HTMLButtonElement;

// Dictation strip (IDs preserved from cycle 2)
const dictationHint     = document.getElementById('dictationHint') as HTMLParagraphElement;
const dictationBadge    = document.getElementById('dictationBadge') as HTMLParagraphElement;
const dictationNotice   = document.getElementById('dictationNotice') as HTMLParagraphElement;
const dictationBanner   = document.getElementById('dictationBanner') as HTMLElement | null;
const dictationGrantBtn = document.getElementById('dictationGrantBtn') as HTMLButtonElement | null;
const dictationEnabledChk = document.getElementById('dictationEnabledChk') as HTMLInputElement;

// Main content
const emptyState        = document.getElementById('emptyState') as HTMLElement;
const emptyRecordBtn    = document.getElementById('emptyRecordBtn') as HTMLButtonElement;
const emptyImportBtn    = document.getElementById('emptyImportBtn') as HTMLButtonElement;
const noteDetail        = document.getElementById('noteDetail') as HTMLElement;
const noteTitle         = document.getElementById('noteTitle') as HTMLInputElement;
const noteDate          = document.getElementById('noteDate') as HTMLSpanElement;
const noteDuration      = document.getElementById('noteDuration') as HTMLSpanElement;
const noteSource        = document.getElementById('noteSource') as HTMLSpanElement;
const noteFolderSelect  = document.getElementById('noteFolderSelect') as HTMLSelectElement;
const noteTagsList      = document.getElementById('noteTagsList') as HTMLElement;
const addTagBtn         = document.getElementById('addTagBtn') as HTMLButtonElement;
const reTranscribeBtn   = document.getElementById('reTranscribeBtn') as HTMLButtonElement;
const deleteNoteBtn     = document.getElementById('deleteNoteBtn') as HTMLButtonElement;

// Input modal
const inputModal        = document.getElementById('inputModal') as HTMLDivElement;
const inputModalTitle   = document.getElementById('inputModalTitle') as HTMLHeadingElement;
const inputModalHint    = document.getElementById('inputModalHint') as HTMLParagraphElement;
const inputModalField   = document.getElementById('inputModalField') as HTMLInputElement;
const inputModalCancel  = document.getElementById('inputModalCancel') as HTMLButtonElement;
const inputModalConfirm = document.getElementById('inputModalConfirm') as HTMLButtonElement;

function showInputDialog(title: string, placeholder = '', hint = '', defaultValue = ''): Promise<string | null> {
  return new Promise((resolve) => {
    if (!inputModal || !inputModalField) {
      resolve(null);
      return;
    }
    inputModalTitle.textContent = title;
    inputModalField.placeholder = placeholder;
    inputModalField.value = defaultValue;
    if (hint) {
      inputModalHint.textContent = hint;
      inputModalHint.hidden = false;
    } else {
      inputModalHint.hidden = true;
    }
    inputModal.hidden = false;
    inputModalField.focus();
    inputModalField.select();

    const cleanup = () => {
      inputModal.hidden = true;
      inputModalConfirm.onclick = null;
      inputModalCancel.onclick = null;
      inputModalField.onkeydown = null;
    };

    inputModalConfirm.onclick = () => {
      const val = inputModalField.value;
      cleanup();
      resolve(val);
    };

    inputModalCancel.onclick = () => {
      cleanup();
      resolve(null);
    };

    inputModalField.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        inputModalConfirm.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        inputModalCancel.click();
      }
    };
  });
}

// Recording pill
const recordingPill     = document.getElementById('recordingPill') as HTMLElement;
const pillLabel         = document.getElementById('pillLabel') as HTMLSpanElement;
const pillTimer         = document.getElementById('pillTimer') as HTMLSpanElement;
const stopRecordBtn     = document.getElementById('stopRecordBtn') as HTMLButtonElement;
const cancelBtn         = document.getElementById('cancelBtn') as HTMLButtonElement;

// Status bar
const statusBar         = document.getElementById('statusBar') as HTMLElement;
const statusText        = document.getElementById('statusText') as HTMLParagraphElement;
const progressBar       = document.getElementById('progressBar') as HTMLProgressElement;
const errorText         = document.getElementById('errorText') as HTMLParagraphElement;

// Tabs + panels
const tabTranscript     = document.getElementById('tabTranscript') as HTMLButtonElement;
const tabSummary        = document.getElementById('tabSummary') as HTMLButtonElement;
const transcriptPanel   = document.getElementById('transcriptPanel') as HTMLElement;
const summaryPanel      = document.getElementById('summaryPanel') as HTMLElement;
const transcriptArea    = document.getElementById('transcriptArea') as HTMLTextAreaElement;
const copyBtn           = document.getElementById('copyBtn') as HTMLButtonElement;
const saveBtn           = document.getElementById('saveBtn') as HTMLButtonElement;
const saveSrtBtn        = document.getElementById('saveSrtBtn') as HTMLButtonElement;
const saveVttBtn        = document.getElementById('saveVttBtn') as HTMLButtonElement;
const summarizeBtn      = document.getElementById('summarizeBtn') as HTMLButtonElement;
const summaryPromptSelect = document.getElementById('summaryPromptSelect') as HTMLSelectElement;
const summaryActionGroup  = document.getElementById('summaryActionGroup') as HTMLDivElement;
const cancelSummaryBtn  = document.getElementById('cancelSummaryBtn') as HTMLButtonElement;
const summaryRawBtn     = document.getElementById('summaryRawBtn') as HTMLButtonElement;
const summaryPreviewBtn = document.getElementById('summaryPreviewBtn') as HTMLButtonElement;
const copySummaryBtn    = document.getElementById('copySummaryBtn') as HTMLButtonElement;
const summaryStaleHint  = document.getElementById('summaryStaleHint') as HTMLSpanElement;
const summaryStatus     = document.getElementById('summaryStatus') as HTMLParagraphElement;
const summaryError      = document.getElementById('summaryError') as HTMLParagraphElement;
const summaryPreview    = document.getElementById('summaryPreview') as HTMLElement;
const summaryArea       = document.getElementById('summaryArea') as HTMLTextAreaElement;

// Saved paths
const savedPanel        = document.getElementById('savedPanel') as HTMLElement;
const savedTranscriptPath = document.getElementById('savedTranscriptPath') as HTMLParagraphElement;
const savedSummaryPath  = document.getElementById('savedSummaryPath') as HTMLParagraphElement;
const saveErrorText     = document.getElementById('saveErrorText') as HTMLParagraphElement;

// Settings slide-over
const settingsPanel     = document.getElementById('settingsPanel') as HTMLElement;
const settingsCloseBtn  = document.getElementById('settingsCloseBtn') as HTMLButtonElement;
const settingsSaveBtn   = document.getElementById('settingsSaveBtn') as HTMLButtonElement;
const settingsStatus    = document.getElementById('settingsStatus') as HTMLParagraphElement;
const pythonPathInput   = document.getElementById('pythonPathInput') as HTMLInputElement;
const pythonBrowseBtn   = document.getElementById('pythonBrowseBtn') as HTMLButtonElement;
const pythonDefaultBtn  = document.getElementById('pythonDefaultBtn') as HTMLButtonElement;
const pythonValidateBtn = document.getElementById('pythonValidateBtn') as HTMLButtonElement;
const pythonStatus      = document.getElementById('pythonStatus') as HTMLParagraphElement;
const llmBaseUrlInput   = document.getElementById('llmBaseUrlInput') as HTMLInputElement;
const llmModelSelect    = document.getElementById('llmModelSelect') as HTMLSelectElement;
const llmApiKeyInput    = document.getElementById('llmApiKeyInput') as HTMLInputElement;
const llmRefreshBtn     = document.getElementById('llmRefreshBtn') as HTMLButtonElement;
const llmTestBtn        = document.getElementById('llmTestBtn') as HTMLButtonElement;
const llmStatus         = document.getElementById('llmStatus') as HTMLParagraphElement;
const dataDirInput      = document.getElementById('dataDirInput') as HTMLInputElement;
const dataDirBrowseBtn  = document.getElementById('dataDirBrowseBtn') as HTMLButtonElement;
const dataDirStatus     = document.getElementById('dataDirStatus') as HTMLParagraphElement;
const watchFolderInput  = document.getElementById('watchFolderInput') as HTMLInputElement;
const watchFolderBrowseBtn = document.getElementById('watchFolderBrowseBtn') as HTMLButtonElement;
const watchFolderClearBtn = document.getElementById('watchFolderClearBtn') as HTMLButtonElement;
const cacheDirInput     = document.getElementById('cacheDirInput') as HTMLInputElement;
const cacheDirBrowseBtn = document.getElementById('cacheDirBrowseBtn') as HTMLButtonElement;
const cacheDirStatus    = document.getElementById('cacheDirStatus') as HTMLParagraphElement;
const audioRetentionDaysInput = document.getElementById('audioRetentionDaysInput') as HTMLInputElement;
const cleanOldAudioBtn = document.getElementById('cleanOldAudioBtn') as HTMLButtonElement;
const audioRetentionStatus = document.getElementById('audioRetentionStatus') as HTMLParagraphElement;
const summarizeEnabledChk = document.getElementById('summarizeEnabledChk') as HTMLInputElement;
const autoSummarizeChk  = document.getElementById('autoSummarizeChk') as HTMLInputElement;
const promptPurposeSelect = document.getElementById('promptPurposeSelect') as HTMLSelectElement;
const promptSetDefaultBtn = document.getElementById('promptSetDefaultBtn') as HTMLButtonElement;
const promptNewBtn        = document.getElementById('promptNewBtn') as HTMLButtonElement;
const promptResetBtn      = document.getElementById('promptResetBtn') as HTMLButtonElement;
const promptDeleteBtn     = document.getElementById('promptDeleteBtn') as HTMLButtonElement;
const promptNameInput     = document.getElementById('promptNameInput') as HTMLInputElement;
const promptDescInput     = document.getElementById('promptDescInput') as HTMLInputElement;
const promptTemplateArea  = document.getElementById('promptTemplateArea') as HTMLTextAreaElement;
const promptEditorStatus  = document.getElementById('promptEditorStatus') as HTMLParagraphElement;
const sttActiveModelStatus = document.getElementById('sttActiveModelStatus') as HTMLParagraphElement;
const recordingShortcutInput  = document.getElementById('recordingShortcutInput') as HTMLInputElement;
const recordShortcutBtn      = document.getElementById('recordShortcutBtn') as HTMLButtonElement;
const resetShortcutBtn       = document.getElementById('resetShortcutBtn') as HTMLButtonElement;
const recordingShortcutStatus = document.getElementById('recordingShortcutStatus') as HTMLParagraphElement;
const recordingShortcutKbd   = document.getElementById('recordingShortcutKbd') as HTMLElement;
const emptyHintKbd           = document.getElementById('emptyHintKbd') as HTMLElement;
const hfSearchInput     = document.getElementById('hfSearchInput') as HTMLInputElement;
const hfSearchBtn       = document.getElementById('hfSearchBtn') as HTMLButtonElement;
const hfStatus          = document.getElementById('hfStatus') as HTMLParagraphElement;
const hfResults         = document.getElementById('hfResults') as HTMLElement;
const hfInstalled       = document.getElementById('hfInstalled') as HTMLElement;
const hfDownloadBtn     = document.getElementById('hfDownloadBtn') as HTMLButtonElement;
const hfUseBtn          = document.getElementById('hfUseBtn') as HTMLButtonElement;
const hfCancelDownloadBtn = document.getElementById('hfCancelDownloadBtn') as HTMLButtonElement;
const downloadProgress  = document.getElementById('downloadProgress') as HTMLProgressElement;
const downloadStatus    = document.getElementById('downloadStatus') as HTMLParagraphElement;
const fileInput         = document.getElementById('fileInput') as HTMLInputElement;
const reTranscribeFileInput = document.getElementById('reTranscribeFileInput') as HTMLInputElement;

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

type AppView = 'home' | 'all' | 'dictation' | 'folder';
type SummaryView = 'raw' | 'preview';
type HintState = '' | 'ok' | 'error' | 'info';

let currentView: AppView = 'home';
let currentFolder: string = '';
let selectedNoteId: string | null = null;
let notes: NoteInfo[] = [];
let folders: string[] = [];
let folderCounts: Record<string, number> = {};
let currentNoteContent: NoteContent = { transcript: '', summary: '' };
let currentSettings: AppSettings | null = null;
let summaryView: SummaryView = 'preview';
let selectedModelId: string | null = null;
let installedModels: string[] = [];
let activeModel = '';
let noteSearchTimer: number | undefined;
let llmLoadTimer: number | undefined;
let currentSearchQuery = '';

const CUSTOM_FOLDERS_KEY = 'nadabodha_custom_folders';

function getSavedCustomFolders(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_FOLDERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCustomFolders(list: string[]): void {
  try {
    localStorage.setItem(CUSTOM_FOLDERS_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

let isRecording = false;
let recordingInterval: number | undefined;
let recordingStartTime = 0;
let pendingTranscriptNoteId: string | null = null; // note to update after re-transcribe
/**
 * D4: true while a re-transcribe run is in flight. The button stays disabled
 * (and a second trigger is ignored) until the run reaches a terminal event.
 */
let retranscribeInFlight = false;
let isTranscribing = false;

/** Exact hint string for global dictation. */
const DICTATION_HINT = 'Press ⌥ Space anywhere to dictate';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function setHint(element: HTMLElement, text: string, state: HintState = ''): void {
  element.textContent = text;
  element.hidden = !text;
  element.setAttribute('data-state', state);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatShortDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'recording': return 'Recording';
    case 'import': return 'Import';
    case 'dictation-log': return 'Dictation';
    default: return 'Note';
  }
}

// ---------------------------------------------------------------------------
// DOMPurify + marked (Markdown preview, same pattern as cycle 2)
// ---------------------------------------------------------------------------

let sanitizeHooksInstalled = false;
function ensureSanitizeHooks(): void {
  if (sanitizeHooksInstalled) return;
  sanitizeHooksInstalled = true;
  const SRC_ELEMENTS = ['IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'EMBED'];
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (!SRC_ELEMENTS.includes(el.tagName)) return;
    const src = el.getAttribute('src') || '';
    if (!/^(https?:|data:)/i.test(src)) el.removeAttribute('src');
  });
}

function emptyStateEl(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

function renderMarkdown(md: string): void {
  if (!md.trim()) {
    summaryPreview.innerHTML = '';
    summaryPreview.appendChild(emptyStateEl('No summary yet.'));
    return;
  }
  try {
    if (typeof DOMPurify === 'undefined' || typeof marked === 'undefined') {
      summaryPreview.innerHTML = '';
      summaryPreview.appendChild(emptyStateEl('Preview unavailable (library not loaded).'));
      return;
    }
    ensureSanitizeHooks();
    const rawHtml = marked.parse(md);
    const htmlStr = typeof rawHtml === 'string' ? rawHtml : '';
    summaryPreview.innerHTML = DOMPurify.sanitize(htmlStr, { USE_PROFILES: { html: true } });
  } catch {
    summaryPreview.innerHTML = '';
    summaryPreview.appendChild(emptyStateEl('Preview render error.'));
  }
}

// ---------------------------------------------------------------------------
// Notes: loading and rendering
// ---------------------------------------------------------------------------

function updateNotesListLabel(): void {
  if (currentSearchQuery) {
    notesListLabel.textContent = `Search results (${notes.length})`;
  } else if (currentView === 'all') {
    notesListLabel.textContent = 'All notes';
  } else if (currentView === 'dictation') {
    notesListLabel.textContent = 'Dictation log';
  } else if (currentView === 'folder') {
    notesListLabel.textContent = currentFolder || 'Folder';
  } else {
    notesListLabel.textContent = 'Recent';
  }
}

async function loadNotes(searchQuery = ''): Promise<void> {
  try {
    currentSearchQuery = searchQuery.trim();
    let result: NoteListResult;
    if (currentSearchQuery) {
      result = await api.searchNotes(currentSearchQuery);
    } else {
      result = await api.listNotes();
    }
    notes = result.notes || [];

    // Merge backend folders with custom persistent folders
    const backendFolders = result.folders || [];
    const savedCustomFolders = getSavedCustomFolders();
    folders = Array.from(new Set([...backendFolders, ...savedCustomFolders])).sort();
    folderCounts = result.folderCounts || {};

    const totalCount = Object.values(folderCounts).reduce((sum, c) => sum + c, 0);
    allCount.textContent = String(totalCount);

    updateNotesListLabel();
    renderFolderList();
    renderNoteList();
  } catch (err) {
    console.error('[renderer] loadNotes error:', err);
  }
}

function renderFolderList(): void {
  folderList.innerHTML = '';
  for (const folder of folders) {
    const li = document.createElement('li');
    li.className = 'folder-item' + (currentView === 'folder' && currentFolder === folder ? ' active' : '');
    li.setAttribute('role', 'listitem');

    const iconSpan = document.createElement('span');
    iconSpan.className = 'nav-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.textContent = '📁';
    li.appendChild(iconSpan);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'folder-name';
    nameSpan.textContent = folder;
    li.appendChild(nameSpan);

    const countSpan = document.createElement('span');
    countSpan.className = 'folder-count';
    countSpan.textContent = String(folderCounts[folder] || 0);
    li.appendChild(countSpan);

    // Delete folder button (appears on hover)
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'folder-delete-btn';
    deleteBtn.title = 'Delete folder';
    deleteBtn.setAttribute('aria-label', `Delete folder ${folder}`);
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const count = folderCounts[folder] || 0;
      const msg = count > 0
        ? `Delete folder "${folder}"? Its ${count} note(s) will be moved to Unfiled.`
        : `Delete folder "${folder}"?`;
      if (!confirm(msg)) return;

      try {
        await api.deleteFolder(folder);
      } catch (err) {
        console.error('Failed to delete folder on disk:', err);
      }

      const saved = getSavedCustomFolders().filter(f => f !== folder);
      saveCustomFolders(saved);

      if (currentView === 'folder' && currentFolder === folder) {
        currentView = 'home';
        currentFolder = '';
        setActiveNav(navHome);
      }
      await loadNotes(currentSearchQuery);
    });
    li.appendChild(deleteBtn);

    li.addEventListener('click', async () => {
      clearSearch();
      currentView = 'folder';
      currentFolder = folder;
      setActiveNav(null);
      renderFolderList();
      await loadNotes();
    });
    folderList.appendChild(li);
  }
}

function filteredNotes(): NoteInfo[] {
  if (currentSearchQuery) {
    return notes;
  }
  switch (currentView) {
    case 'all': return notes;
    case 'dictation': return notes.filter(n => n.source === 'dictation-log');
    case 'folder': return notes.filter(n => n.folder === currentFolder);
    default: return notes.slice(0, 20); // home: recent 20
  }
}

function renderNoteList(): void {
  noteList.innerHTML = '';
  const visible = filteredNotes();
  noteListEmpty.hidden = visible.length > 0;

  if (visible.length === 0) {
    if (currentSearchQuery) {
      noteListEmpty.textContent = `No notes found matching "${currentSearchQuery}".`;
    } else if (currentView === 'folder') {
      noteListEmpty.textContent = `No notes in "${currentFolder}".`;
    } else if (currentView === 'dictation') {
      noteListEmpty.textContent = 'No dictation notes yet. Press ⌥ Space to dictate.';
    } else {
      noteListEmpty.innerHTML = 'No notes yet.<br>Record, import, or dictate to create one.';
    }
  }

  for (const note of visible) {
    const li = document.createElement('li');
    li.className = 'note-item' + (note.id === selectedNoteId ? ' active' : '');
    li.setAttribute('role', 'listitem');
    li.dataset.id = note.id;

    const title = document.createElement('p');
    title.className = 'note-item-title';
    title.textContent = note.title;

    const meta = document.createElement('div');
    meta.className = 'note-item-meta';

    const date = document.createElement('span');
    date.className = 'note-item-date';
    date.textContent = formatShortDate(note.created);

    const badge = document.createElement('span');
    badge.className = `source-badge ${note.source}`;
    badge.textContent = sourceLabel(note.source);

    meta.appendChild(date);
    meta.appendChild(badge);

    if (note.tags && note.tags.length > 0) {
      for (const t of note.tags.slice(0, 3)) {
        const tagSpan = document.createElement('span');
        tagSpan.className = 'note-item-tag';
        tagSpan.textContent = `#${t}`;
        meta.appendChild(tagSpan);
      }
    }

    li.appendChild(title);
    li.appendChild(meta);

    // Delete button for this note item
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'note-item-delete';
    deleteBtn.title = 'Delete note';
    deleteBtn.setAttribute('aria-label', `Delete ${note.title}`);
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${note.title}"? This cannot be undone.`)) return;
      if (selectedNoteId === note.id) {
        selectedNoteId = null;
        emptyState.hidden = false;
        noteDetail.hidden = true;
      }
      await api.deleteNote(note.id);
      await loadNotes(currentSearchQuery);
    });
    li.appendChild(deleteBtn);

    li.addEventListener('click', () => openNote(note.id));
    noteList.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Note detail
// ---------------------------------------------------------------------------

async function openNote(id: string): Promise<void> {
  selectedNoteId = id;
  renderNoteList(); // highlight

  try {
    const result = await api.getNote(id);
    if (!result.note) {
      showError(result.error || 'Note not found');
      return;
    }
    const note = result.note;
    currentNoteContent = result.content || { transcript: '', summary: '' };

    // Show note detail, hide empty state
    emptyState.hidden = true;
    noteDetail.hidden = false;

    // Populate header
    noteTitle.value = note.title;
    noteDate.textContent = formatDate(note.created);
    noteDuration.textContent = note.duration ? formatDuration(note.duration) : '';
    noteSource.textContent = sourceLabel(note.source);
    noteSource.className = `note-source-badge ${note.source}`;

    // Tags
    renderNoteTags(note);

    // Folder select
    refreshFolderSelect(note.folder);
    noteFolderSelect.value = note.folder || '';

    // Re-transcribe button state
    syncReTranscribeButton();

    // Transcript
    transcriptArea.value = currentNoteContent.transcript;
    copyBtn.disabled = !currentNoteContent.transcript;
    saveBtn.disabled = !currentNoteContent.transcript;
    saveSrtBtn.disabled = !currentNoteContent.transcript;
    saveVttBtn.disabled = !currentNoteContent.transcript;

    // Summary
    summaryArea.value = currentNoteContent.summary;
    copySummaryBtn.disabled = !currentNoteContent.summary;
    summaryStaleHint.hidden = !note.summaryStale;

    if (summaryView === 'preview') {
      renderMarkdown(currentNoteContent.summary);
    }

    // Summarize button: enable if there's a transcript
    summarizeBtn.disabled = !currentNoteContent.transcript;
    if (summaryPromptSelect) summaryPromptSelect.disabled = !currentNoteContent.transcript;

    // Status bar: show transcription status if relevant
    updateStatusBar({ status: 'idle' });
  } catch (err) {
    showError(String(err));
  }
}

function renderNoteTags(note: NoteInfo): void {
  if (!noteTagsList) return;
  noteTagsList.innerHTML = '';
  const tags = note.tags || [];
  for (const tag of tags) {
    const badge = document.createElement('span');
    badge.className = 'tag-badge';
    badge.textContent = `#${tag} `;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'tag-remove-btn';
    removeBtn.type = 'button';
    removeBtn.title = `Remove tag #${tag}`;
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const updatedTags = (note.tags || []).filter((t) => t !== tag);
      const res = await api.updateNote({ id: note.id, tags: updatedTags });
      if (res.success && res.note) {
        note.tags = res.note.tags;
        renderNoteTags(note);
        await loadNotes(currentSearchQuery);
      }
    });
    badge.appendChild(removeBtn);
    noteTagsList.appendChild(badge);
  }
}

addTagBtn?.addEventListener('click', async () => {
  if (!selectedNoteId) return;
  const note = notes.find((n) => n.id === selectedNoteId);
  if (!note) return;
  const input = await showInputDialog('Add Tag', 'e.g. Meeting, Work, Ideas', 'Tags help organize and automatically file your notes.');
  if (!input || !input.trim()) return;
  const cleanTag = input.trim().replace(/^#/, '');
  const existing = note.tags || [];
  if (existing.map((t) => t.toLowerCase()).includes(cleanTag.toLowerCase())) return;
  const updatedTags = [...existing, cleanTag];
  const res = await api.updateNote({ id: note.id, tags: updatedTags });
  if (res.success && res.note) {
    note.tags = res.note.tags;
    if (res.note.folder) {
      note.folder = res.note.folder;
      noteFolderSelect.value = res.note.folder;
    }
    renderNoteTags(note);
    await loadNotes(currentSearchQuery);
  }
});

function refreshFolderSelect(currentFolder: string): void {
  noteFolderSelect.innerHTML = '<option value="">Unfiled</option>';
  for (const f of folders) {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    noteFolderSelect.appendChild(opt);
  }
  // Add current folder if not in list
  if (currentFolder && !folders.includes(currentFolder)) {
    const opt = document.createElement('option');
    opt.value = currentFolder;
    opt.textContent = currentFolder;
    noteFolderSelect.appendChild(opt);
  }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

interface StatusState { status: string; text?: string; progress?: number; error?: string; }

function updateStatusBar(state: StatusState): void {
  const { status, text, progress, error } = state;

  if (status === 'idle') {
    statusBar.hidden = true;
    progressBar.hidden = true;
    errorText.hidden = true;
    return;
  }

  statusBar.hidden = false;

  if (error) {
    statusText.textContent = error;
    errorText.textContent = error;
    errorText.hidden = false;
    progressBar.hidden = true;
    return;
  }

  errorText.hidden = true;

  switch (status) {
    case 'recording':
      statusText.textContent = 'Recording…';
      progressBar.hidden = true;
      break;
    case 'transcribing':
      statusText.textContent = `Transcribing… ${progress != null ? `${progress}%` : ''}`;
      if (progress != null) {
        progressBar.value = progress;
        progressBar.hidden = false;
      }
      break;
    case 'summarizing':
      statusText.textContent = `Summarizing… ${progress != null ? `${progress}%` : ''}`;
      if (progress != null) {
        progressBar.value = progress;
        progressBar.hidden = false;
      }
      break;
    case 'completed':
      statusText.textContent = text ? `Done: ${text.slice(0, 50)}…` : 'Done';
      progressBar.hidden = true;
      break;
    case 'cancelled':
      statusText.textContent = 'Cancelled.';
      progressBar.hidden = true;
      break;
    case 'error':
      statusText.textContent = error || 'An error occurred';
      progressBar.hidden = true;
      break;
    default:
      statusText.textContent = `Status: ${status}`;
  }
}

function showError(msg: string): void {
  statusBar.hidden = false;
  errorText.textContent = msg;
  errorText.hidden = false;
  // Keep the reason in #statusText too: blanking it here left the pipeline
  // showing an empty status exactly when it had just died with a reason.
  statusText.textContent = msg;
}

// ---------------------------------------------------------------------------
// Recording pill
// ---------------------------------------------------------------------------

function startRecordingUI(): void {
  isRecording = true;
  recordingStartTime = Date.now();
  recordingPill.hidden = false;
  pillLabel.textContent = 'Recording';

  if (recordingInterval) clearInterval(recordingInterval);
  recordingInterval = window.setInterval(() => {
    pillTimer.textContent = formatElapsed(Date.now() - recordingStartTime);
  }, 1000);

  recordBtn.classList.add('recording');
  recordBtn.innerHTML = '<span class="action-icon" aria-hidden="true">⏹</span> Stop';
  updateStatusBar({ status: 'recording' });
}

function stopRecordingUI(): void {
  isRecording = false;
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = undefined;
  }
  recordingPill.hidden = true;
  recordBtn.classList.remove('recording');
  recordBtn.innerHTML = '<span class="action-icon" aria-hidden="true">⏺</span> Record';
}

// ---------------------------------------------------------------------------
// Dictation UI
// ---------------------------------------------------------------------------

function applyDictationStatus(info: DictationStatusInfo): void {
  const supported = info.supported;
  const enabled = info.enabled;

  if (dictationBanner) {
    dictationBanner.hidden = true;
  }
  dictationHint.hidden = !supported || !enabled;
  dictationHint.textContent = DICTATION_HINT;
  dictationEnabledChk.checked = enabled;

  const dictationStrip = document.getElementById('dictationStrip');
  if (dictationStrip) {
    dictationStrip.hidden = !supported || !enabled;
  }
}

let dictationStatusInterval: number | undefined;
function startDictationPolling(): void {
  if (dictationStatusInterval) return;
  dictationStatusInterval = window.setInterval(async () => {
    try {
      const status = await api.getDictationStatus();
      applyDictationStatus(status);
    } catch { /* ignore */ }
  }, 1500);
}

// ---------------------------------------------------------------------------
// Nav helpers
// ---------------------------------------------------------------------------

function setActiveNav(btn: HTMLButtonElement | null): void {
  [navHome, navAll, navDictation].forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

// ---------------------------------------------------------------------------
// Transcription event handler
// ---------------------------------------------------------------------------

function handleTranscriptionEvent(event: TranscriptionEvent): void {
  const { status, text, progress, error, origin, dictationNotice: notice } = event;

  if (origin === 'dictation') {
    // Dictation-specific UI updates
    dictationBadge.hidden = status !== 'recording' && status !== 'transcribing';
    if (event.partial && text) {
      dictationBadge.textContent = '🎙️ ' + text;
      dictationBadge.style.opacity = '0.7';
    } else if (status === 'recording') {
      dictationBadge.textContent = '🎙️ Dictation active — Press ⌥ Space to stop';
      dictationBadge.style.opacity = '1';
    }

    if (notice) {
      setHint(dictationNotice, notice, 'info');
      dictationNotice.hidden = false;
      dictationNotice.textContent = notice;
    }
    if (status === 'error' && error) {
      // A dictation take whose transcription died must say WHY instead of
      // silently hiding the badge.
      showError(error);
    }
    if (status === 'completed' && text) {
      dictationBadge.textContent = '🎙️ Dictation active';
      // Append to today's dictation log note (which updates transcriptArea
      // immediately if the dictation log note is currently selected).
      appendDictationText(text);
    }
    return;
  }

  if (origin === 'download') {
    // Pass through to download status
    updateDownloadStatus(event);
    return;
  }

  if (origin === 'summary') {
    handleSummaryEvent(event);
    return;
  }

  // D3: system-audio (catap) capture failed while the microphone keeps
  // recording — surface the failure in the status bar WITHOUT tearing down
  // the recording UI (stopRecordingUI here would hide the Stop button).
  if (event.meetingError) {
    if (!isRecording) startRecordingUI();
    updateStatusBar({ status: 'recording', error: event.meetingError });
    return;
  }

  // D4: the run ends on a terminal status — release the re-transcribe
  // guard so the button reflects the open note again.
  if (status === 'completed' || status === 'error' || status === 'cancelled') {
    isTranscribing = false;
    retranscribeInFlight = false;
    syncReTranscribeButton();
  }

  // Transcription events
  updateStatusBar({ status, text, progress, error });

  if (status === 'recording') {
    startRecordingUI();
  } else if (status === 'transcribing') {
    if (event.partial && text) {
      // We are streaming during recording.
      transcriptArea.value = text;
      transcriptArea.style.opacity = '0.7';
    } else if (!isRecording) {
      // Progress lines from the file pass mean the recording UI is already
      // done — but while a recording is live these are warm-up progress, and
      // tearing the pill down here hid the Stop button seconds after start.
      isTranscribing = true;
      stopRecordingUI();
    }
  } else if (status === 'completed' && text) {
    stopRecordingUI();
    transcriptArea.style.opacity = '1.0';
    handleTranscriptionCompleted(text, event);
  } else if (status === 'cancelled' || status === 'error') {
    stopRecordingUI();
    transcriptArea.style.opacity = '1.0';
    if (status === 'error' && error) showError(error);
    setTimeout(() => updateStatusBar({ status: 'idle' }), 3000);
  }
}

async function handleTranscriptionCompleted(text: string, event: TranscriptionEvent): Promise<void> {
  // D4: the run token main stamped on the event wins over the renderer's
  // single slot, so a completion can never land on a different note even if
  // the slot was overwritten by a second trigger.
  const routedNoteId = event.reTranscribeNoteId ?? pendingTranscriptNoteId;
  pendingTranscriptNoteId = null;
  if (routedNoteId) {
    const noteId = routedNoteId;
    // D4 replace + record which model produced the new transcript (plan note
    // field 'model').
    await api.updateNote({ id: noteId, transcript: text, model: activeModel, markSummaryStale: true });
    await loadNotes();
    if (selectedNoteId === noteId) {
      openNote(noteId);
    }
    return;
  }

  // Create a new note for this transcription
  const source = 'recording'; // default; import sets this differently
  const result = await api.createNote({ source, transcript: text, tags: event.tags });
  if (result.success && result.note) {
    await loadNotes();
    openNote(result.note.id);
  }

  // Auto-save notification
  if (event.savedTranscriptPath) {
    savedTranscriptPath.textContent = `Saved: ${event.savedTranscriptPath}`;
    savedTranscriptPath.hidden = false;
    savedPanel.hidden = false;
  }
  if (event.savedSummaryPath) {
    savedSummaryPath.textContent = `Summary: ${event.savedSummaryPath}`;
    savedSummaryPath.hidden = false;
    savedPanel.hidden = false;
  }
  if (event.saveError) {
    saveErrorText.textContent = event.saveError;
    saveErrorText.hidden = false;
    savedPanel.hidden = false;
  }

  // Re-enable transcript actions
  transcriptArea.value = text;
  copyBtn.disabled = !text;
  saveBtn.disabled = !text;
  saveSrtBtn.disabled = !text;
  saveVttBtn.disabled = !text;
  summarizeBtn.disabled = !text;
  if (summaryPromptSelect) summaryPromptSelect.disabled = !text;

  // Scroll back to idle after a brief moment
  setTimeout(() => updateStatusBar({ status: 'idle' }), 2000);
}

async function appendDictationText(text: string): Promise<void> {
  // Find today's dictation log note
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const title = `Dictation Log - ${today}`;
  
  let logNote = notes.find(n => n.source === 'dictation-log' && n.title === title);
  
  if (logNote) {
    const result = await api.readNoteContent(logNote.id);
    const existing = result.content?.transcript || '';
    const updated = existing ? existing + '\n\n' + text : text;
    await api.updateNote({ id: logNote.id, transcript: updated });
    
    // If it's the currently selected note, update UI immediately
    if (selectedNoteId === logNote.id) {
      currentNoteContent.transcript = updated;
      transcriptArea.value = updated;
      copyBtn.disabled = false;
      saveBtn.disabled = false;
      saveSrtBtn.disabled = false;
      saveVttBtn.disabled = false;
    }
  } else {
    // Create new log note for today
    const req = {
      title,
      source: 'dictation-log',
      folder: 'Dictation',
      transcript: text
    };
    const result = await api.createNote(req);
    if (result.success && result.note) {
      logNote = result.note;
    }
  }
  
  // Reload notes to reflect new size/content
  await loadNotes();
}

function handleSummaryEvent(event: TranscriptionEvent): void {
  const { status, text, progress, error } = event;

  if (status === 'summarizing') {
    setHint(summaryStatus, progress != null ? `Summarizing… ${progress}%` : 'Summarizing…');
    cancelSummaryBtn.hidden = false;
    summarizeBtn.hidden = true;
    if (summaryPromptSelect) summaryPromptSelect.disabled = true;
  } else if (status === 'completed' && text) {
    setHint(summaryStatus, '');
    cancelSummaryBtn.hidden = true;
    summarizeBtn.hidden = false;
    if (summaryPromptSelect) summaryPromptSelect.disabled = false;
    currentNoteContent.summary = text;
    summaryArea.value = text;
    copySummaryBtn.disabled = false;
    if (summaryView === 'preview') renderMarkdown(text);
    summaryStaleHint.hidden = true;

    // Persist summary to the current note
    if (selectedNoteId) {
      api.updateNote({ id: selectedNoteId, summary: text, clearSummaryStale: true }).catch(console.error);
    }
    if (event.savedSummaryPath) {
      savedSummaryPath.textContent = `Summary saved: ${event.savedSummaryPath}`;
      savedSummaryPath.hidden = false;
      savedPanel.hidden = false;
    }
  } else if (status === 'cancelled') {
    setHint(summaryStatus, 'Summary cancelled.');
    cancelSummaryBtn.hidden = true;
    summarizeBtn.hidden = false;
    if (summaryPromptSelect) summaryPromptSelect.disabled = false;
  } else if (status === 'error') {
    setHint(summaryError, error || 'Summary failed');
    summaryError.hidden = false;
    cancelSummaryBtn.hidden = true;
    summarizeBtn.hidden = false;
    if (summaryPromptSelect) summaryPromptSelect.disabled = false;
  }
}

function updateDownloadStatus(event: TranscriptionEvent): void {
  const { status, progress, file, bytesDone, bytesTotal, error } = event;
  if (status === 'downloading') {
    const pct = progress != null ? `${Math.round(progress)}%` : '';
    const bytes = bytesTotal ? ` (${Math.round((bytesDone || 0) / 1024 / 1024)}/${Math.round(bytesTotal / 1024 / 1024)} MB)` : '';
    setHint(downloadStatus, `Downloading ${file || ''}… ${pct}${bytes}`);
    if (progress != null) {
      downloadProgress.value = progress;
      downloadProgress.hidden = false;
    }
    hfCancelDownloadBtn.hidden = false;
  } else if (status === 'completed') {
    setHint(downloadStatus, 'Download complete!', 'ok');
    downloadProgress.hidden = true;
    hfCancelDownloadBtn.hidden = true;
    loadHfModels(); // refresh installed list
  } else if (status === 'error') {
    setHint(downloadStatus, error || 'Download failed', 'error');
    downloadProgress.hidden = true;
    hfCancelDownloadBtn.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function switchTab(which: 'transcript' | 'summary'): void {
  const showTranscript = which === 'transcript';
  tabTranscript.classList.toggle('active', showTranscript);
  tabTranscript.setAttribute('aria-selected', String(showTranscript));
  tabSummary.classList.toggle('active', !showTranscript);
  tabSummary.setAttribute('aria-selected', String(!showTranscript));
  transcriptPanel.hidden = !showTranscript;
  summaryPanel.hidden = showTranscript;
}

function switchSummaryView(view: SummaryView): void {
  summaryView = view;
  const isRaw = view === 'raw';
  summaryRawBtn.classList.toggle('active', isRaw);
  summaryRawBtn.setAttribute('aria-pressed', String(isRaw));
  summaryPreviewBtn.classList.toggle('active', !isRaw);
  summaryPreviewBtn.setAttribute('aria-pressed', String(!isRaw));
  summaryArea.hidden = !isRaw;
  summaryPreview.hidden = isRaw;
  if (!isRaw) renderMarkdown(currentNoteContent.summary);
}

// ---------------------------------------------------------------------------
// Prompt Purposes & Customization
// ---------------------------------------------------------------------------

const BUILTIN_PROMPTS: CustomPrompt[] = [
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

let editingPrompts: CustomPrompt[] = [];
let editingDefaultPromptId = 'general';
let selectedPromptToEdit = 'general';

function updateSummaryPromptDropdown(): void {
  if (!summaryPromptSelect) return;
  const prompts = (currentSettings && currentSettings.customPrompts && currentSettings.customPrompts.length > 0)
    ? currentSettings.customPrompts
    : BUILTIN_PROMPTS;
  const defaultId = currentSettings?.defaultPromptId || 'general';

  const prevVal = summaryPromptSelect.value;
  summaryPromptSelect.innerHTML = '';
  for (const p of prompts) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.id === defaultId ? `${p.name} (Default)` : p.name;
    summaryPromptSelect.appendChild(opt);
  }
  if (prevVal && prompts.some(p => p.id === prevVal)) {
    summaryPromptSelect.value = prevVal;
  } else {
    summaryPromptSelect.value = defaultId;
  }
}

function syncActivePromptFromInputs(): void {
  if (!selectedPromptToEdit) return;
  const p = editingPrompts.find(item => item.id === selectedPromptToEdit);
  if (!p) return;
  if (promptNameInput) p.name = promptNameInput.value.trim() || p.name;
  if (promptDescInput) p.description = promptDescInput.value.trim();
  if (promptTemplateArea) p.template = promptTemplateArea.value;
}

function renderPromptEditor(): void {
  if (!promptPurposeSelect) return;

  if (editingPrompts.length === 0) {
    editingPrompts = BUILTIN_PROMPTS.map(p => ({ ...p }));
  }
  if (!editingPrompts.some(p => p.id === editingDefaultPromptId)) {
    editingDefaultPromptId = editingPrompts[0].id;
  }
  if (!editingPrompts.some(p => p.id === selectedPromptToEdit)) {
    selectedPromptToEdit = editingDefaultPromptId;
  }

  promptPurposeSelect.innerHTML = '';
  for (const p of editingPrompts) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.id === editingDefaultPromptId ? `★ ${p.name} (Default)` : p.name;
    promptPurposeSelect.appendChild(opt);
  }
  promptPurposeSelect.value = selectedPromptToEdit;

  const current = editingPrompts.find(p => p.id === selectedPromptToEdit);
  if (!current) return;

  if (promptNameInput) promptNameInput.value = current.name;
  if (promptDescInput) promptDescInput.value = current.description || '';
  if (promptTemplateArea) promptTemplateArea.value = current.template;

  const isDefault = current.id === editingDefaultPromptId;
  if (promptSetDefaultBtn) {
    promptSetDefaultBtn.disabled = isDefault;
    promptSetDefaultBtn.textContent = isDefault ? '✓ Default' : '★ Set as Default';
  }
  if (promptResetBtn) {
    promptResetBtn.style.display = current.isBuiltIn ? 'inline-block' : 'none';
  }
  if (promptDeleteBtn) {
    promptDeleteBtn.style.display = current.isBuiltIn ? 'none' : 'inline-block';
  }
}

if (promptPurposeSelect) {
  promptPurposeSelect.addEventListener('change', () => {
    syncActivePromptFromInputs();
    selectedPromptToEdit = promptPurposeSelect.value;
    renderPromptEditor();
  });
}

if (promptNameInput) {
  promptNameInput.addEventListener('input', () => {
    const p = editingPrompts.find(item => item.id === selectedPromptToEdit);
    if (p) {
      p.name = promptNameInput.value;
      const opt = promptPurposeSelect.querySelector(`option[value="${p.id}"]`);
      if (opt) {
        opt.textContent = p.id === editingDefaultPromptId ? `★ ${p.name || 'Untitled'} (Default)` : (p.name || 'Untitled');
      }
    }
  });
}

if (promptDescInput) {
  promptDescInput.addEventListener('input', () => {
    const p = editingPrompts.find(item => item.id === selectedPromptToEdit);
    if (p) p.description = promptDescInput.value;
  });
}

if (promptTemplateArea) {
  promptTemplateArea.addEventListener('input', () => {
    const p = editingPrompts.find(item => item.id === selectedPromptToEdit);
    if (p) p.template = promptTemplateArea.value;
  });
}

if (promptSetDefaultBtn) {
  promptSetDefaultBtn.addEventListener('click', () => {
    editingDefaultPromptId = selectedPromptToEdit;
    renderPromptEditor();
    if (promptEditorStatus) setHint(promptEditorStatus, 'Set as default summarization purpose.', 'ok');
  });
}

if (promptNewBtn) {
  promptNewBtn.addEventListener('click', () => {
    syncActivePromptFromInputs();
    const id = 'custom-' + Date.now().toString(36);
    const newPrompt: CustomPrompt = {
      id,
      name: 'Custom Purpose',
      description: 'Custom summarization prompt',
      template: `Summarize the following transcript:\n\nTranscript:\n{{transcript}}\n`,
      isBuiltIn: false,
    };
    editingPrompts.push(newPrompt);
    selectedPromptToEdit = id;
    renderPromptEditor();
    if (promptNameInput) {
      promptNameInput.focus();
      promptNameInput.select();
    }
    if (promptEditorStatus) setHint(promptEditorStatus, 'Created new purpose. Click Save Settings to persist.', 'info');
  });
}

if (promptDeleteBtn) {
  promptDeleteBtn.addEventListener('click', () => {
    const p = editingPrompts.find(item => item.id === selectedPromptToEdit);
    if (!p || p.isBuiltIn) return;
    editingPrompts = editingPrompts.filter(item => item.id !== selectedPromptToEdit);
    if (editingDefaultPromptId === selectedPromptToEdit) {
      editingDefaultPromptId = editingPrompts[0]?.id || 'general';
    }
    selectedPromptToEdit = editingDefaultPromptId;
    renderPromptEditor();
    if (promptEditorStatus) setHint(promptEditorStatus, 'Custom purpose removed. Click Save Settings to persist.', 'info');
  });
}

if (promptResetBtn) {
  promptResetBtn.addEventListener('click', () => {
    const original = BUILTIN_PROMPTS.find(p => p.id === selectedPromptToEdit);
    const p = editingPrompts.find(item => item.id === selectedPromptToEdit);
    if (original && p) {
      p.name = original.name;
      p.description = original.description;
      p.template = original.template;
      renderPromptEditor();
      if (promptEditorStatus) setHint(promptEditorStatus, 'Template reset to built-in default.', 'ok');
    }
  });
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

function openSettings(): void {
  settingsPanel.hidden = false;
  settingsBtn.setAttribute('aria-expanded', 'true');
  loadSettings();
}

function closeSettings(): void {
  settingsPanel.hidden = true;
  settingsBtn.setAttribute('aria-expanded', 'false');
}

async function loadSettings(): Promise<void> {
  try {
    currentSettings = await api.getSettings();
    if (!currentSettings) return;
    pythonPathInput.value = currentSettings.pythonPath || '';
    if (currentSettings.defaultPythonPath) {
      pythonPathInput.placeholder = currentSettings.defaultPythonPath;
      if (!pythonPathInput.value) {
        setHint(pythonStatus, `Default: ${currentSettings.defaultPythonPath}`, 'info');
      }
    }
    llmBaseUrlInput.value = currentSettings.llmBaseUrl || '';
    llmApiKeyInput.value = currentSettings.llmApiKey || '';
    dataDirInput.value = currentSettings.dataDir || '';
    watchFolderInput.value = currentSettings.watchFolderDir || '';
    cacheDirInput.value = currentSettings.sttCacheDir || '';
    summarizeEnabledChk.checked = currentSettings.summarizationEnabled;
    autoSummarizeChk.checked = currentSettings.autoSummarize;
    (document.getElementById('settingsDictationChk') as HTMLInputElement).checked = currentSettings.dictationEnabled;
    (document.getElementById('dictationPasteChk') as HTMLInputElement).checked = currentSettings.dictationPasteEnabled !== false;
    (document.getElementById('meetingModeChk') as HTMLInputElement).checked = currentSettings.meetingModeEnabled === true;
    activeModel = currentSettings.activeModel || '';
    updateActiveModelDisplay();

    // Preserve saved LLM model in select options
    const savedLlmModel = currentSettings.llmModel;
    if (savedLlmModel) {
      if (!Array.from(llmModelSelect.options).some(o => o.value === savedLlmModel)) {
        const opt = document.createElement('option');
        opt.value = savedLlmModel;
        opt.textContent = savedLlmModel;
        llmModelSelect.appendChild(opt);
      }
      llmModelSelect.value = savedLlmModel;
    }

    // Global recording shortcut
    const shortcut = currentSettings.recordingShortcut || 'CommandOrControl+Shift+R';
    if (recordingShortcutInput) recordingShortcutInput.value = shortcut;
    updateShortcutBadges(shortcut);
    if (recordingShortcutStatus) setHint(recordingShortcutStatus, '');

    // Audio retention
    if (audioRetentionDaysInput) {
      audioRetentionDaysInput.value = String(currentSettings.audioRetentionDays ?? 90);
    }
    if (audioRetentionStatus) setHint(audioRetentionStatus, '');

    // Prompt templates
    editingPrompts = (currentSettings.customPrompts && currentSettings.customPrompts.length > 0)
      ? currentSettings.customPrompts.map(p => ({ ...p }))
      : BUILTIN_PROMPTS.map(p => ({ ...p }));
    editingDefaultPromptId = currentSettings.defaultPromptId || 'general';
    selectedPromptToEdit = editingDefaultPromptId;
    renderPromptEditor();
    if (promptEditorStatus) setHint(promptEditorStatus, '');

    // Populate STT model cards immediately upon opening settings
    await loadHfModels();
  } catch (err) {
    setHint(settingsStatus, String(err), 'error');
  }
}

function updateActiveModelDisplay(): void {
  const label = activeModel ? `Active model: ${activeModel}` : 'No STT model selected (using built-in fallback)';
  if (sttActiveModelStatus) setHint(sttActiveModelStatus, label, activeModel ? 'ok' : 'info');
}

function formatShortcutDisplay(accelerator: string): string {
  if (!accelerator) return '⌘⇧R';
  let s = accelerator.trim();
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  if (isMac) {
    s = s.replace(/CommandOrControl/gi, '⌘');
    s = s.replace(/CmdOrCtrl/gi, '⌘');
    s = s.replace(/Command/gi, '⌘');
    s = s.replace(/Cmd/gi, '⌘');
    s = s.replace(/Control/gi, '⌃');
    s = s.replace(/Ctrl/gi, '⌃');
    s = s.replace(/Alt/gi, '⌥');
    s = s.replace(/Option/gi, '⌥');
    s = s.replace(/Shift/gi, '⇧');
    s = s.replace(/\+/g, '');
  } else {
    s = s.replace(/CommandOrControl/gi, 'Ctrl');
    s = s.replace(/CmdOrCtrl/gi, 'Ctrl');
    s = s.replace(/Command/gi, 'Win');
    s = s.replace(/Option/gi, 'Alt');
  }
  return s;
}

function updateShortcutBadges(accelerator: string): void {
  const display = formatShortcutDisplay(accelerator || 'CommandOrControl+Shift+R');
  if (recordingShortcutKbd) recordingShortcutKbd.textContent = display;
  if (emptyHintKbd) emptyHintKbd.textContent = display;
}

let isCapturingShortcut = false;

function startCapturingShortcut(): void {
  if (isCapturingShortcut) return;
  isCapturingShortcut = true;
  if (recordShortcutBtn) {
    recordShortcutBtn.textContent = 'Press keys…';
    recordShortcutBtn.classList.add('capturing');
  }
  setHint(recordingShortcutStatus, 'Press desired key combination (e.g. ⌘⇧R, Ctrl+Alt+R, F9). Esc to cancel.', 'info');
  if (recordingShortcutInput) recordingShortcutInput.focus();
}

function stopCapturingShortcut(): void {
  if (!isCapturingShortcut) return;
  isCapturingShortcut = false;
  if (recordShortcutBtn) {
    recordShortcutBtn.textContent = 'Capture';
    recordShortcutBtn.classList.remove('capturing');
  }
}

recordShortcutBtn?.addEventListener('click', () => {
  if (isCapturingShortcut) {
    stopCapturingShortcut();
    setHint(recordingShortcutStatus, '');
  } else {
    startCapturingShortcut();
  }
});

resetShortcutBtn?.addEventListener('click', () => {
  stopCapturingShortcut();
  if (recordingShortcutInput) recordingShortcutInput.value = 'CommandOrControl+Shift+R';
  updateShortcutBadges('CommandOrControl+Shift+R');
  setHint(recordingShortcutStatus, 'Reset to default: CommandOrControl+Shift+R. Click "Save settings" to persist.', 'ok');
});

recordingShortcutInput?.addEventListener('input', () => {
  updateShortcutBadges(recordingShortcutInput.value.trim());
});

recordingShortcutInput?.addEventListener('keydown', (e) => {
  if (!isCapturingShortcut) return;
  e.preventDefault();
  e.stopPropagation();

  // Escape cancels capture
  if (e.key === 'Escape') {
    stopCapturingShortcut();
    setHint(recordingShortcutStatus, 'Capture cancelled.');
    return;
  }

  // Strictly disallow Space as a keybind
  if (e.code === 'Space') {
    setHint(recordingShortcutStatus, 'Space cannot be used as a keybinding. Please use standard modifiers and letters or function keys.', 'error');
    return;
  }

  // Ignore bare modifier presses
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) {
    return;
  }

  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) {
    parts.push('CommandOrControl');
  }
  if (e.altKey) {
    parts.push('Alt');
  }
  if (e.shiftKey) {
    parts.push('Shift');
  }

  let keyName = e.key;
  if (e.code.startsWith('Key')) {
    keyName = e.code.substring(3).toUpperCase();
  } else if (e.code.startsWith('Digit')) {
    keyName = e.code.substring(5);
  } else if (/^F\d{1,2}$/i.test(e.key)) {
    keyName = e.key.toUpperCase();
  } else if (keyName.length === 1) {
    keyName = keyName.toUpperCase();
  }

  parts.push(keyName);
  const accelerator = parts.join('+');
  if (recordingShortcutInput) recordingShortcutInput.value = accelerator;
  updateShortcutBadges(accelerator);
  stopCapturingShortcut();
  setHint(recordingShortcutStatus, `Captured: ${accelerator}. Click "Save settings" to apply.`, 'ok');
});

async function saveSettings(): Promise<void> {
  syncActivePromptFromInputs();
  const patch: Partial<AppSettings> = {
    pythonPath: pythonPathInput.value.trim(),
    llmBaseUrl: llmBaseUrlInput.value.trim(),
    llmModel: llmModelSelect.value,
    llmApiKey: llmApiKeyInput.value.trim(),
    dataDir: dataDirInput.value.trim(),
    watchFolderDir: watchFolderInput.value.trim(),
    sttCacheDir: cacheDirInput.value.trim(),
    summarizationEnabled: summarizeEnabledChk.checked,
    autoSummarize: autoSummarizeChk.checked,
    dictationEnabled: (document.getElementById('settingsDictationChk') as HTMLInputElement).checked,
    dictationPasteEnabled: (document.getElementById('dictationPasteChk') as HTMLInputElement).checked,
    meetingModeEnabled: (document.getElementById('meetingModeChk') as HTMLInputElement).checked,
    customPrompts: editingPrompts,
    defaultPromptId: editingDefaultPromptId,
    recordingShortcut: recordingShortcutInput ? recordingShortcutInput.value.trim() || 'CommandOrControl+Shift+R' : undefined,
    audioRetentionDays: audioRetentionDaysInput ? Math.max(0, parseInt(audioRetentionDaysInput.value, 10) || 0) : 90,
  };
  if (activeModel) patch.activeModel = activeModel;

  try {
    const result = await api.updateSettings(patch);
    currentSettings = result.settings;
    updateSummaryPromptDropdown();
    const errors = result.errors || {};
    const hasErrors = Object.keys(errors).length > 0;
    if (hasErrors) {
      setHint(settingsStatus, Object.values(errors).join('; '), 'error');
    } else {
      setHint(settingsStatus, 'Settings saved.', 'ok');
    }
    if (errors.pythonPath) setHint(pythonStatus, errors.pythonPath, 'error');
    if (errors.dataDir) setHint(dataDirStatus, errors.dataDir, 'error');
    if (errors.sttCacheDir) setHint(cacheDirStatus, errors.sttCacheDir, 'error');
    if (errors.recordingShortcut) setHint(recordingShortcutStatus, errors.recordingShortcut, 'error');
    const messages = result.messages || {};
    if (messages.pythonPath) setHint(pythonStatus, messages.pythonPath, errors.pythonPath ? 'error' : 'ok');
    setTimeout(() => setHint(settingsStatus, ''), 3000);
  } catch (err) {
    setHint(settingsStatus, String(err), 'error');
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Curated featured models (shown by default without a search)
// ---------------------------------------------------------------------------

interface FeaturedModel {
  id: string;
  label: string;
  size: string;
  description: string;
  kind: 'ctranslate2' | 'pytorch';
}

const FEATURED_MODELS: FeaturedModel[] = [
  // OpenAI Whisper — via faster-whisper (CTranslate2, CPU-friendly)
  { id: 'Systran/faster-whisper-tiny',   label: 'Whisper Tiny',   size: '~75 MB',  description: 'Fastest, lowest accuracy',         kind: 'ctranslate2' },
  { id: 'Systran/faster-whisper-base',   label: 'Whisper Base',   size: '~145 MB', description: 'Good balance for short clips',      kind: 'ctranslate2' },
  { id: 'Systran/faster-whisper-small',  label: 'Whisper Small',  size: '~465 MB', description: 'Recommended for most use cases',    kind: 'ctranslate2' },
  { id: 'Systran/faster-whisper-medium', label: 'Whisper Medium', size: '~1.4 GB', description: 'High accuracy, needs ~4 GB RAM',    kind: 'ctranslate2' },
  { id: 'deepdml/faster-whisper-large-v3-turbo-ct2', label: 'Whisper Large v3 Turbo', size: '~1.6 GB', description: 'Large v3 accuracy at 4x speed', kind: 'ctranslate2' },
  { id: 'Systran/faster-whisper-large-v3', label: 'Whisper Large v3', size: '~3 GB', description: 'Best accuracy, needs ~8 GB RAM', kind: 'ctranslate2' },
  // OpenAI Whisper — Official PyTorch
  { id: 'openai/whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo (PyTorch)', size: '~1.6 GB', description: 'Official OpenAI Turbo model', kind: 'pytorch' },
  // Nvidia NeMo — via transformers (PyTorch)
  { id: 'nvidia/canary-1b',    label: 'Nvidia Canary 1B',      size: '~4 GB', description: 'High accuracy, multilingual NeMo model',  kind: 'pytorch' },
  { id: 'nvidia/parakeet-tdt-0.6b-v2', label: 'Nvidia Parakeet 0.6B', size: '~2.4 GB', description: 'Fast English ASR, NeMo model', kind: 'pytorch' },
];

function renderFeaturedModels(): void {
  const container = document.getElementById('featuredList');
  if (!container) return;
  container.innerHTML = '';

  for (const m of FEATURED_MODELS) {
    const isInstalled = installedModels.includes(m.id);
    const isActive    = m.id === activeModel;
    const isSelected  = m.id === selectedModelId;

    const card = document.createElement('div');
    card.className = 'hf-featured-card' + (isSelected ? ' selected' : '') + (isInstalled ? ' installed' : '');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-pressed', String(isSelected));

    const badge = m.kind === 'ctranslate2'
      ? 'OpenAI · CTranslate2'
      : (m.id.startsWith('openai/') ? 'OpenAI · PyTorch' : 'Nvidia · PyTorch');
    card.innerHTML = `
      <div class="hf-featured-header">
        <span class="hf-featured-label">${m.label}</span>
        <span class="hf-featured-size">${m.size}</span>
      </div>
      <p class="hf-featured-desc">${m.description}</p>
      <div class="hf-featured-footer">
        <span class="hf-featured-badge">${badge}</span>
        ${isInstalled ? `<span class="hf-featured-installed">${isActive ? '✓ Active' : 'Installed'}</span>` : ''}
      </div>`;

    card.addEventListener('click', () => {
      selectedModelId = m.id;
      renderFeaturedModels();
      // Also deselect anything in the search results list
      document.querySelectorAll('.hf-model-item').forEach(el =>
        el.classList.toggle('selected', el.querySelector('.hf-model-id')?.textContent === selectedModelId)
      );
      renderHfSelection();
    });
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') card.click(); });

    container.appendChild(card);
  }
}

// HF model browser (preserving the existing UX from cycle 2)
// ---------------------------------------------------------------------------

async function loadHfModels(query = ''): Promise<void> {
  setHint(hfStatus, 'Loading models…');
  hfResults.innerHTML = '';
  hfInstalled.innerHTML = '';

  try {
    const result = await api.listHfModels(query);
    installedModels = result.installed || [];
    activeModel = result.activeModel || activeModel;

    // Always re-render featured cards so their Installed/Active badges update.
    renderFeaturedModels();

    if (result.error) {
      setHint(hfStatus, result.error, 'error');
    } else {
      setHint(hfStatus, `${result.models.length} model${result.models.length !== 1 ? 's' : ''} found`);
    }

    // Installed — skip any that are already shown as featured cards
    const featuredIds = new Set(FEATURED_MODELS.map(m => m.id));
    for (const id of installedModels) {
      if (featuredIds.has(id)) continue; // shown in featured section instead
      const el = document.createElement('div');
      el.className = 'hf-model-item' + (id === selectedModelId ? ' selected' : '');
      el.innerHTML = `<span class="hf-model-id">${id}</span><span class="hf-model-format">Installed${id === activeModel ? ' ✓ Active' : ''}</span>`;
      el.addEventListener('click', () => { selectedModelId = id; renderHfSelection(); });
      hfInstalled.appendChild(el);
    }

    // Search results
    for (const model of result.models) {
      const el = document.createElement('div');
      el.className = 'hf-model-item' + (model.id === selectedModelId ? ' selected' : '');
      el.innerHTML = `<span class="hf-model-id">${model.id}</span><span class="hf-model-format">${model.format}</span>`;
      if (model.kind === 'unsupported') el.style.opacity = '0.5';
      el.addEventListener('click', () => {
        if (model.kind !== 'unsupported') { selectedModelId = model.id; renderHfSelection(); }
      });
      hfResults.appendChild(el);
    }

    renderHfSelection();
  } catch (err) {
    setHint(hfStatus, String(err), 'error');
  }
}

function renderHfSelection(): void {
  const hasSelection = !!selectedModelId;
  const isInstalled = installedModels.includes(selectedModelId || '');
  document.getElementById('hfActions')!.hidden = !hasSelection;
  hfDownloadBtn.hidden = isInstalled;
  hfUseBtn.hidden = !isInstalled;
  // Update selected styling
  document.querySelectorAll('.hf-model-item').forEach(el => {
    el.classList.toggle('selected', el.querySelector('.hf-model-id')?.textContent === selectedModelId);
  });
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function clearSearch(): void {
  searchInput.value = '';
  searchClearBtn.hidden = true;
  currentSearchQuery = '';
}

// Search
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  searchClearBtn.hidden = !q;
  clearTimeout(noteSearchTimer);
  noteSearchTimer = window.setTimeout(() => loadNotes(q), 250);
});

searchClearBtn.addEventListener('click', () => {
  clearSearch();
  loadNotes();
  searchInput.focus();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!settingsPanel.hidden) {
      closeSettings();
      return;
    }
    if (document.activeElement === searchInput) {
      clearSearch();
      loadNotes();
      searchInput.blur();
      return;
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  // Cmd/Ctrl + R: Toggle recording
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    handleRecordBtnClick();
    return;
  }
});

// Global shortcut listener from main process
if (api.onToggleRecording) {
  api.onToggleRecording(() => {
    handleRecordBtnClick();
  });
}

// Navigation
navHome.addEventListener('click', async () => {
  clearSearch();
  currentView = 'home';
  currentFolder = '';
  setActiveNav(navHome);
  await loadNotes();
});

navAll.addEventListener('click', async () => {
  clearSearch();
  currentView = 'all';
  currentFolder = '';
  setActiveNav(navAll);
  await loadNotes();
});

navDictation.addEventListener('click', async () => {
  clearSearch();
  currentView = 'dictation';
  currentFolder = '';
  setActiveNav(navDictation);
  await loadNotes();
});

addFolderBtn.addEventListener('click', async () => {
  const name = await showInputDialog('New Folder', 'Folder name…', 'Create a new folder to organize your notes.');
  if (!name || !name.trim()) return;
  const folderName = name.trim();
  try {
    const res = await api.createFolder(folderName);
    if (!res.success && res.error) {
      showError(res.error);
      return;
    }
  } catch (err) {
    console.error('Failed to create folder on disk:', err);
  }
  const saved = getSavedCustomFolders();
  if (!saved.includes(folderName)) {
    saved.push(folderName);
    saveCustomFolders(saved);
  }
  if (!folders.includes(folderName)) {
    folders.push(folderName);
    folders.sort();
  }
  renderFolderList();
  if (selectedNoteId) {
    const currentNote = notes.find(n => n.id === selectedNoteId);
    refreshFolderSelect(currentNote?.folder || '');
  }
});

// Record buttons (sidebar + empty state)
let startingRecording = false;
async function startRecording(): Promise<void> {
  if (startingRecording || isRecording) return;
  if (isTranscribing) {
    showError('Transcription in progress. Please wait for it to finish.');
    return;
  }
  startingRecording = true;
  try {
    const meetingModeChk = document.getElementById('meetingModeChk') as HTMLInputElement;
    const res = await api.startRecording({ meetingMode: meetingModeChk ? meetingModeChk.checked : false });
    if (res && res.error) {
      showError(res.error);
      return;
    }
    // The recording event will arrive via onTranscriptionEvent
    pendingTranscriptNoteId = null;
  } catch (err) {
    showError(String(err));
  } finally {
    startingRecording = false;
  }
}

async function handleRecordBtnClick(): Promise<void> {
  if (isRecording) {
    try {
      await api.stopRecording();
    } catch (err) {
      showError(String(err));
    }
    return;
  }
  if (isTranscribing) {
    showError('Transcription in progress. Please wait for it to finish.');
    return;
  }
  await startRecording();
}

recordBtn.addEventListener('click', handleRecordBtnClick);
emptyRecordBtn?.addEventListener('click', handleRecordBtnClick);

// Stop / cancel recording
stopRecordBtn.addEventListener('click', async () => {
  try {
    await api.stopRecording();
  } catch (err) {
    showError(String(err));
  }
});

cancelBtn.addEventListener('click', async () => {
  try {
    await api.cancelTranscription();
    stopRecordingUI();
    updateStatusBar({ status: 'idle' });
  } catch (err) {
    showError(String(err));
  }
});

// Import audio
async function importAudio(): Promise<void> {
  fileInput.click();
}

importBtn.addEventListener('click', importAudio);
emptyImportBtn?.addEventListener('click', importAudio);

fileInput.addEventListener('change', async () => {
  const files = fileInput.files;
  if (!files || files.length === 0) return;
  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = api.getPathForFile ? api.getPathForFile(file) : (file as unknown as { path?: string }).path || '';
    if (filePath) paths.push(filePath);
  }
  fileInput.value = '';
  if (paths.length === 0) { showError('Could not get file paths'); return; }
  try {
    await api.enqueueImports(paths);
  } catch (err) {
    showError(String(err));
  }
});

// Tabs
tabTranscript.addEventListener('click', () => switchTab('transcript'));
tabSummary.addEventListener('click', () => switchTab('summary'));
summaryRawBtn.addEventListener('click', () => switchSummaryView('raw'));
summaryPreviewBtn.addEventListener('click', () => switchSummaryView('preview'));

// Transcript copy / save
copyBtn.addEventListener('click', async () => {
  await api.copyTranscript(transcriptArea.value);
  copyBtn.textContent = 'Copied!';
  setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
});

saveBtn.addEventListener('click', async () => {
  const filePath = await api.requestSavePath();
  if (!filePath) return;
  const result = await api.saveTranscript({ filePath, text: transcriptArea.value });
  if (result.success) {
    savedTranscriptPath.textContent = `Saved: ${result.filePath}`;
    savedTranscriptPath.hidden = false;
    savedPanel.hidden = false;
  } else {
    showError(result.error || 'Save failed');
  }
});

saveSrtBtn.addEventListener('click', async () => {
  const filePath = await api.requestSavePath();
  if (!filePath) return;
  const result = await api.saveTranscript({ filePath, text: transcriptArea.value, format: 'srt', words: currentNoteContent.words });
  if (result.success) {
    savedTranscriptPath.textContent = `Saved: ${result.filePath}`;
    savedTranscriptPath.hidden = false;
    savedPanel.hidden = false;
  } else {
    showError(result.error || 'Save failed');
  }
});

saveVttBtn.addEventListener('click', async () => {
  const filePath = await api.requestSavePath();
  if (!filePath) return;
  const result = await api.saveTranscript({ filePath, text: transcriptArea.value, format: 'vtt', words: currentNoteContent.words });
  if (result.success) {
    savedTranscriptPath.textContent = `Saved: ${result.filePath}`;
    savedTranscriptPath.hidden = false;
    savedPanel.hidden = false;
  } else {
    showError(result.error || 'Save failed');
  }
});

// Summarize
summarizeBtn.addEventListener('click', async () => {
  const promptId = summaryPromptSelect ? summaryPromptSelect.value : undefined;
  const result = await api.summarize({ text: transcriptArea.value || undefined, promptId });
  if (!result.started && result.error) setHint(summaryStatus, result.error, 'error');
  else switchTab('summary');
});

cancelSummaryBtn.addEventListener('click', async () => {
  await api.cancelSummary();
});

copySummaryBtn.addEventListener('click', async () => {
  await api.copyTranscript(summaryArea.value);
  copySummaryBtn.textContent = 'Copied!';
  setTimeout(() => { copySummaryBtn.textContent = 'Copy Markdown'; }, 1500);
});

// Note detail actions
noteTitle.addEventListener('blur', async () => {
  if (!selectedNoteId) return;
  const newTitle = noteTitle.value.trim();
  if (!newTitle) return;
  await api.updateNote({ id: selectedNoteId, title: newTitle });
  await loadNotes(currentSearchQuery);
});

noteFolderSelect.addEventListener('change', async () => {
  if (!selectedNoteId) return;
  await api.updateNote({ id: selectedNoteId, folder: noteFolderSelect.value });
  await loadNotes(currentSearchQuery);
});

/**
 * D4: single source of truth for the re-transcribe button state — disabled
 * while a run is in flight. If the note has no audio, clicking it allows
 * attaching an audio file and transcribing it.
 */
function syncReTranscribeButton(): void {
  const note = notes.find((n) => n.id === selectedNoteId);
  const hasAudio = Boolean(note && note.hasAudio);
  reTranscribeBtn.disabled = retranscribeInFlight;
  if (retranscribeInFlight) {
    reTranscribeBtn.textContent = '↻ Re-transcribing…';
    reTranscribeBtn.title = 'A re-transcribe run is already in progress';
  } else {
    reTranscribeBtn.textContent = '↻ Re-transcribe';
    reTranscribeBtn.title = hasAudio
      ? 'Re-transcribe using the current model'
      : 'Select an audio file to transcribe for this note';
  }
}

async function executeReTranscribe(noteId: string): Promise<void> {
  retranscribeInFlight = true;
  syncReTranscribeButton();
  let result: { started: boolean; error?: string; runId?: number };
  try {
    result = await api.reTranscribe(noteId);
  } catch (err) {
    result = { started: false, error: String(err) };
  }
  if (!result.started) {
    retranscribeInFlight = false;
    syncReTranscribeButton();
    showError(result.error || 'Re-transcribe failed to start');
    return;
  }
  pendingTranscriptNoteId = noteId;
  updateStatusBar({ status: 'transcribing' });
}

reTranscribeBtn.addEventListener('click', async () => {
  if (!selectedNoteId || retranscribeInFlight) return;
  const note = notes.find((n) => n.id === selectedNoteId);
  const hasAudio = Boolean(note && note.hasAudio);

  if (!hasAudio) {
    // Note has no audio stored — let the user pick an audio file to attach and transcribe
    reTranscribeFileInput.click();
    return;
  }

  await executeReTranscribe(selectedNoteId);
});

reTranscribeFileInput.addEventListener('change', async () => {
  const files = reTranscribeFileInput.files;
  if (!files || files.length === 0 || !selectedNoteId) return;
  const file = files[0];
  const filePath = api.getPathForFile ? api.getPathForFile(file) : (file as unknown as { path?: string }).path || '';
  reTranscribeFileInput.value = '';
  if (!filePath) {
    showError('Could not get audio file path');
    return;
  }
  const noteId = selectedNoteId;
  try {
    const updateResult = await api.updateNote({ id: noteId, audioPath: filePath });
    if (!updateResult.success) {
      showError(updateResult.error || 'Failed to attach audio file');
      return;
    }
    await loadNotes(currentSearchQuery);
    await openNote(noteId);
    await executeReTranscribe(noteId);
  } catch (err) {
    showError(String(err));
  }
});

deleteNoteBtn.addEventListener('click', async () => {
  if (!selectedNoteId) return;
  const note = notes.find(n => n.id === selectedNoteId);
  if (!confirm(`Delete "${note?.title || 'this note'}"? This cannot be undone.`)) return;
  const idToDelete = selectedNoteId;
  selectedNoteId = null;
  emptyState.hidden = false;
  noteDetail.hidden = true;
  await api.deleteNote(idToDelete);
  await loadNotes(currentSearchQuery);
});

// Dictation
dictationGrantBtn?.addEventListener('click', async () => {
  await api.requestDictationAccess();
  const status = await api.getDictationStatus();
  applyDictationStatus(status);
});

// Settings
function toggleSettings(): void {
  if (settingsPanel.hidden) {
    openSettings();
  } else {
    closeSettings();
  }
}

settingsBtn.addEventListener('click', toggleSettings);
settingsCloseBtn.addEventListener('click', closeSettings);

const sidebarBrand = document.querySelector('.sidebar-brand') as HTMLElement | null;
sidebarBrand?.addEventListener('click', () => {
  navHome.click();
});
settingsSaveBtn.addEventListener('click', saveSettings);

pythonBrowseBtn.addEventListener('click', async () => {
  const p = await api.pickPythonFile();
  if (p) pythonPathInput.value = p;
});

pythonDefaultBtn?.addEventListener('click', () => {
  const def = currentSettings?.defaultPythonPath || '/Volumes/personal/conda_envs/misc/bin/python3';
  pythonPathInput.value = def;
  setHint(pythonStatus, 'Set to default misc conda environment. Click Save settings to persist.', 'ok');
});

pythonValidateBtn.addEventListener('click', async () => {
  setHint(pythonStatus, 'Validating…');
  const result = await api.validatePython(pythonPathInput.value.trim());
  setHint(pythonStatus, result.message, result.ok ? 'ok' : 'error');
});

dataDirBrowseBtn.addEventListener('click', async () => {
  const p = await api.pickDirectory('Choose data directory');
  if (p) dataDirInput.value = p;
});

watchFolderBrowseBtn.addEventListener('click', async () => {
  const p = await api.pickWatchFolder();
  if (p) watchFolderInput.value = p;
});

watchFolderClearBtn.addEventListener('click', () => {
  watchFolderInput.value = '';
});

cacheDirBrowseBtn.addEventListener('click', async () => {
  const p = await api.pickDirectory('Choose model cache directory');
  if (p) cacheDirInput.value = p;
});

cleanOldAudioBtn?.addEventListener('click', async () => {
  setHint(audioRetentionStatus, 'Cleaning up old audio recordings…');
  const days = parseInt(audioRetentionDaysInput.value, 10);
  const effectiveDays = Number.isNaN(days) ? 90 : Math.max(0, days);
  if (effectiveDays <= 0) {
    setHint(audioRetentionStatus, 'Retention is set to 0 (Keep indefinitely). No audio deleted.', 'info');
    return;
  }
  try {
    const res = await api.cleanOldAudio(effectiveDays);
    if (res.success) {
      const mb = (res.freedBytes / (1024 * 1024)).toFixed(1);
      const msg = res.deletedCount > 0
        ? `✓ Deleted ${res.deletedCount} audio recording(s) older than ${effectiveDays} days (${mb} MB freed). Note transcripts and summaries preserved.`
        : `✓ No audio recordings older than ${effectiveDays} days found.`;
      setHint(audioRetentionStatus, msg, 'ok');
      await loadNotes(currentSearchQuery);
      if (selectedNoteId) {
        await openNote(selectedNoteId);
      }
    } else {
      setHint(audioRetentionStatus, res.error || 'Cleanup failed', 'error');
    }
  } catch (err) {
    setHint(audioRetentionStatus, String(err), 'error');
  }
});

llmRefreshBtn.addEventListener('click', async () => {
  clearTimeout(llmLoadTimer);
  setHint(llmStatus, 'Loading models…');
  const url = llmBaseUrlInput.value.trim() || currentSettings?.llmBaseUrl;
  const result = await api.testLlmConnection(url);
  llmModelSelect.innerHTML = '';
  for (const m of result.models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    llmModelSelect.appendChild(opt);
  }
  if (currentSettings?.llmModel) llmModelSelect.value = currentSettings.llmModel;
  setHint(llmStatus, result.message, result.ok ? 'ok' : 'error');
});

llmTestBtn.addEventListener('click', async () => {
  setHint(llmStatus, 'Testing…');
  const url = llmBaseUrlInput.value.trim() || currentSettings?.llmBaseUrl;
  const result = await api.testLlmConnection(url);
  setHint(llmStatus, result.message, result.ok ? 'ok' : 'error');
});

hfSearchBtn.addEventListener('click', () => loadHfModels(hfSearchInput.value.trim()));

hfSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadHfModels(hfSearchInput.value.trim());
});

hfDownloadBtn.addEventListener('click', async () => {
  if (!selectedModelId) return;
  setHint(downloadStatus, 'Starting download…');
  const result = await api.downloadModel(selectedModelId);
  if (!result.started && result.error) setHint(downloadStatus, result.error, 'error');
});

hfUseBtn.addEventListener('click', async () => {
  if (!selectedModelId) return;
  activeModel = selectedModelId;

  // Persist immediately — don't wait for the user to click "Save settings".
  try {
    await api.updateSettings({ activeModel });
  } catch { /* non-fatal; in-memory value is still correct */ }

  // Update all visual indicators.
  updateActiveModelDisplay();
  setHint(downloadStatus, `✓ Now using ${activeModel}`, 'ok');

  // Refresh featured cards so the "✓ Active" badge moves to the right card.
  renderFeaturedModels();

  // Refresh the installed flat list too.
  hfInstalled.innerHTML = '';
  const featuredIds = new Set(FEATURED_MODELS.map(m => m.id));
  for (const id of installedModels) {
    if (featuredIds.has(id)) continue;
    const el = document.createElement('div');
    el.className = 'hf-model-item' + (id === selectedModelId ? ' selected' : '');
    el.innerHTML = `<span class="hf-model-id">${id}</span><span class="hf-model-format">Installed${id === activeModel ? ' ✓ Active' : ''}</span>`;
    el.addEventListener('click', () => { selectedModelId = id; renderHfSelection(); });
    hfInstalled.appendChild(el);
  }

  // Also update any search-result rows that match.
  document.querySelectorAll('.hf-model-item').forEach(el => {
    const idEl = el.querySelector('.hf-model-id');
    const fmtEl = el.querySelector('.hf-model-format');
    if (idEl && fmtEl) {
      const id = idEl.textContent || '';
      if (installedModels.includes(id)) {
        fmtEl.textContent = `Installed${id === activeModel ? ' ✓ Active' : ''}`;
      }
    }
  });
});

hfCancelDownloadBtn.addEventListener('click', async () => {
  await api.cancelDownload();
  hfCancelDownloadBtn.hidden = true;
  downloadProgress.hidden = true;
  setHint(downloadStatus, 'Download cancelled.');
});

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  // Load notes
  await loadNotes();

  // Restore status
  try {
    const status = await api.requestStatus();
    if (status.status === 'transcribing') {
      isTranscribing = true;
    }
    updateStatusBar({ status: status.status });
    if (status.text) {
      transcriptArea.value = status.text;
      copyBtn.disabled = !status.text;
      saveBtn.disabled = !status.text;
      saveSrtBtn.disabled = !status.text;
      saveVttBtn.disabled = !status.text;
    }
  } catch { /* ignore */ }

  // Dictation status
  try {
    const dictStatus = await api.getDictationStatus();
    applyDictationStatus(dictStatus);
    startDictationPolling();
  } catch { /* ignore */ }

  // Listen for transcription events
  api.onTranscriptionEvent(handleTranscriptionEvent);
  api.onImportQueueEvent(handleImportQueueEvent);

  // Pre-load settings (for LLM model list, etc.)
  try {
    currentSettings = await api.getSettings();
    if (currentSettings) {
      activeModel = currentSettings.activeModel || '';
      updateSummaryPromptDropdown();
    }
  } catch { /* ignore */ }

  // Harness tripwire (D7.2): reaches true only when this script evaluated
  // AND init() ran to completion — a CommonJS prologue, a thrown top-level
  // statement, or a hung await all leave it undefined.
  window.__nadabodhaReady = true;
}

function handleImportQueueEvent(queue: ImportItem[]) {
  if (!queue || queue.length === 0) {
    importQueueSection.hidden = true;
    importQueueList.innerHTML = '';
    return;
  }
  importQueueSection.hidden = false;
  importQueueList.innerHTML = '';

  for (const item of queue) {
    if (item.status === 'completed' || item.status === 'cancelled') continue;

    const div = document.createElement('div');
    div.className = 'queue-card';
    
    const title = document.createElement('h4');
    title.className = 'queue-card-title';
    title.textContent = item.filePath.split(/[/\\]/).pop() || item.filePath;
    div.appendChild(title);

    const statusP = document.createElement('p');
    statusP.className = 'queue-card-status';
    statusP.textContent = `Status: ${item.status}`;
    div.appendChild(statusP);

    if (item.status === 'transcribing') {
      const prog = document.createElement('progress');
      prog.max = 100;
      prog.value = item.progress || 0;
      div.appendChild(prog);
    }
    
    if (item.error) {
      const err = document.createElement('p');
      err.className = 'error-text';
      err.textContent = item.error;
      div.appendChild(err);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'chip-btn chip-danger';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => api.cancelImportItem(item.id);
    
    const acts = document.createElement('div');
    acts.className = 'queue-card-actions';
    acts.appendChild(cancelBtn);
    div.appendChild(acts);

    importQueueList.appendChild(div);
  }
  
  if (importQueueList.children.length === 0) {
    importQueueSection.hidden = true;
  }
}

init().catch(console.error);
