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
  /** D3: system-audio (catap) capture failed; the mic recording continues. */
  meetingError?: string;
  /** D4: run token — completion routing prefers this over the local slot. */
  reTranscribeNoteId?: string;
  reTranscribeRunId?: number;
}
interface AppSettings {
  pythonPath: string;
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
  startRecording(options?: { meetingMode?: boolean }): Promise<{ outputPath: string }>;
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
  summarize(text?: string): Promise<{ started: boolean; error?: string }>;
  cancelSummary(): Promise<{ cancelled: boolean }>;
  getDictationStatus(): Promise<DictationStatusInfo>;
  requestDictationAccess(): Promise<DictationStatusInfo>;
  listNotes(): Promise<NoteListResult>;
  getNote(id: string): Promise<{ note?: NoteInfo; content?: NoteContent; error?: string }>;
  createNote(req: { title?: string; source: string; folder?: string; transcript?: string }): Promise<{ success: boolean; note?: NoteInfo; error?: string }>;
  updateNote(req: { id: string; title?: string; folder?: string; transcript?: string; summary?: string; model?: string; markSummaryStale?: boolean; clearSummaryStale?: boolean }): Promise<{ success: boolean; note?: NoteInfo; error?: string }>;
  deleteNote(id: string): Promise<{ success: boolean; error?: string }>;
  readNoteContent(id: string): Promise<{ note?: NoteInfo; content?: NoteContent; error?: string }>;
  listFolders(): Promise<{ folders: string[]; counts: Record<string, number> }>;
  searchNotes(q: string): Promise<NoteListResult>;
  reTranscribe(noteId: string): Promise<{ started: boolean; error?: string; runId?: number }>;
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
const dictationBanner   = document.getElementById('dictationBanner') as HTMLElement;
const dictationGrantBtn = document.getElementById('dictationGrantBtn') as HTMLButtonElement;
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
const reTranscribeBtn   = document.getElementById('reTranscribeBtn') as HTMLButtonElement;
const deleteNoteBtn     = document.getElementById('deleteNoteBtn') as HTMLButtonElement;

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
const cacheDirInput     = document.getElementById('cacheDirInput') as HTMLInputElement;
const cacheDirBrowseBtn = document.getElementById('cacheDirBrowseBtn') as HTMLButtonElement;
const cacheDirStatus    = document.getElementById('cacheDirStatus') as HTMLParagraphElement;
const summarizeEnabledChk = document.getElementById('summarizeEnabledChk') as HTMLInputElement;
const autoSummarizeChk  = document.getElementById('autoSummarizeChk') as HTMLInputElement;
const promptPathStatus  = document.getElementById('promptPathStatus') as HTMLParagraphElement;
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
let hfSearchTimer: number | undefined;
let llmLoadTimer: number | undefined;
let isRecording = false;
let recordingInterval: number | undefined;
let recordingStartTime = 0;
let pendingTranscriptNoteId: string | null = null; // note to update after re-transcribe
/**
 * D4: true while a re-transcribe run is in flight. The button stays disabled
 * (and a second trigger is ignored) until the run reaches a terminal event.
 */
let retranscribeInFlight = false;

/** Exact hint string required by the approved plan. */
const DICTATION_HINT = 'Hold the Option key anywhere to dictate';

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

async function loadNotes(searchQuery = ''): Promise<void> {
  try {
    let result: NoteListResult;
    if (searchQuery.trim()) {
      result = await api.searchNotes(searchQuery);
    } else {
      result = await api.listNotes();
    }
    notes = result.notes || [];
    folders = result.folders || [];
    folderCounts = result.folderCounts || {};

    allCount.textContent = String(notes.length);
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
    li.textContent = `${folder}`;
    const countSpan = document.createElement('span');
    countSpan.className = 'folder-count';
    countSpan.textContent = String(folderCounts[folder] || 0);
    li.appendChild(countSpan);
    li.addEventListener('click', () => {
      currentView = 'folder';
      currentFolder = folder;
      notesListLabel.textContent = folder;
      setActiveNav(null);
      renderFolderList();
      renderNoteList();
    });
    folderList.appendChild(li);
  }
}

function filteredNotes(): NoteInfo[] {
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
    date.textContent = new Date(note.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const badge = document.createElement('span');
    badge.className = `source-badge ${note.source}`;
    badge.textContent = sourceLabel(note.source);

    meta.appendChild(date);
    meta.appendChild(badge);
    li.appendChild(title);
    li.appendChild(meta);

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

    // Folder select
    refreshFolderSelect(note.folder);
    noteFolderSelect.value = note.folder || '';

    // Re-transcribe button (D4: disabled with an explanatory tooltip when
    // the note has no audio, or while a run is already in flight).
    reTranscribeBtn.disabled = !note.hasAudio || retranscribeInFlight;
    reTranscribeBtn.title = !note.hasAudio
      ? 'No audio stored — re-transcribe is not available for this note'
      : retranscribeInFlight
        ? 'A re-transcribe run is already in progress'
        : 'Re-transcribe using the current model';

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

    // Status bar: show transcription status if relevant
    updateStatusBar({ status: 'idle' });
  } catch (err) {
    showError(String(err));
  }
}

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
  recordBtn.querySelector('.action-icon')!.textContent = '⏸';
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
  recordBtn.querySelector('.action-icon')!.textContent = '⏺';
}

// ---------------------------------------------------------------------------
// Dictation UI
// ---------------------------------------------------------------------------

function applyDictationStatus(info: DictationStatusInfo): void {
  const supported = info.supported;
  const enabled = info.enabled;
  const trusted = info.accessibilityTrusted;

  // Banner: show when supported + enabled but not trusted
  dictationBanner.hidden = !(supported && enabled && !trusted);
  // Hint: the standard hint when idle and trusted
  dictationHint.hidden = !supported || !enabled || !trusted || !info.running;
  dictationHint.textContent = DICTATION_HINT;
  // Checkbox kept for backward compatibility
  dictationEnabledChk.checked = enabled;
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
      dictationBadge.textContent = '🎙️ Dictation active';
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
      // In-app append fallback (plan Stage 2: "append-in-app becomes the
      // fallback"): the finished take lands in the open transcript view as an
      // append (text = prior transcript + this take), while the dictation-log
      // note below keeps the history. Without this the transcript view never
      // reflected a take unless the log note happened to be selected.
      transcriptArea.value = text;
      transcriptArea.style.opacity = '1.0';
      // Append to existing transcript or create a dictation-log note
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
  const result = await api.createNote({ source, transcript: text });
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
  } else if (status === 'completed' && text) {
    setHint(summaryStatus, '');
    cancelSummaryBtn.hidden = true;
    summarizeBtn.hidden = false;
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
  } else if (status === 'error') {
    setHint(summaryError, error || 'Summary failed');
    summaryError.hidden = false;
    cancelSummaryBtn.hidden = true;
    summarizeBtn.hidden = false;
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
    setHint(promptPathStatus, activeModel ? `Active model: ${activeModel}` : 'No STT model selected');
  } catch (err) {
    setHint(settingsStatus, String(err), 'error');
  }
}

async function saveSettings(): Promise<void> {
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
  };
  if (activeModel) patch.activeModel = activeModel;

  try {
    const result = await api.updateSettings(patch);
    currentSettings = result.settings;
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
    const messages = result.messages || {};
    if (messages.pythonPath) setHint(pythonStatus, messages.pythonPath, errors.pythonPath ? 'error' : 'ok');
    setTimeout(() => setHint(settingsStatus, ''), 3000);
  } catch (err) {
    setHint(settingsStatus, String(err), 'error');
  }
}

// ---------------------------------------------------------------------------
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

    if (result.error) {
      setHint(hfStatus, result.error, 'error');
    } else {
      setHint(hfStatus, `${result.models.length} model${result.models.length !== 1 ? 's' : ''} found`);
    }

    // Installed
    for (const id of installedModels) {
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

// Search
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  searchClearBtn.hidden = !q;
  clearTimeout(hfSearchTimer);
  hfSearchTimer = window.setTimeout(() => loadNotes(q), 300);
});

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchClearBtn.hidden = true;
  loadNotes();
});

// Keyboard shortcut for search
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    searchInput.focus();
  }
});

// Navigation
navHome.addEventListener('click', () => {
  currentView = 'home';
  notesListLabel.textContent = 'Recent';
  setActiveNav(navHome);
  renderFolderList();
  renderNoteList();
});

navAll.addEventListener('click', () => {
  currentView = 'all';
  notesListLabel.textContent = 'All notes';
  setActiveNav(navAll);
  renderFolderList();
  renderNoteList();
});

navDictation.addEventListener('click', () => {
  currentView = 'dictation';
  notesListLabel.textContent = 'Dictation log';
  setActiveNav(navDictation);
  renderFolderList();
  renderNoteList();
});

addFolderBtn.addEventListener('click', () => {
  const name = prompt('Folder name:');
  if (!name || !name.trim()) return;
  const folderName = name.trim();
  if (!folders.includes(folderName)) folders.push(folderName);
  renderFolderList();
});

// Record buttons (sidebar + empty state)
async function startRecording(): Promise<void> {
  try {
    const meetingModeChk = document.getElementById('meetingModeChk') as HTMLInputElement;
    await api.startRecording({ meetingMode: meetingModeChk ? meetingModeChk.checked : false });
    // The recording event will arrive via onTranscriptionEvent
    pendingTranscriptNoteId = null;
  } catch (err) {
    showError(String(err));
  }
}

recordBtn.addEventListener('click', startRecording);
emptyRecordBtn?.addEventListener('click', startRecording);

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
  const result = await api.summarize(transcriptArea.value || undefined);
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
  await loadNotes();
});

noteFolderSelect.addEventListener('change', async () => {
  if (!selectedNoteId) return;
  await api.updateNote({ id: selectedNoteId, folder: noteFolderSelect.value });
  await loadNotes();
});

/**
 * D4: single source of truth for the re-transcribe button state — disabled
 * when the open note has no audio, and while a run is in flight (tooltip
 * explains which of the two applies).
 */
function syncReTranscribeButton(): void {
  const note = notes.find((n) => n.id === selectedNoteId);
  const hasAudio = Boolean(note && note.hasAudio);
  reTranscribeBtn.disabled = !hasAudio || retranscribeInFlight;
  reTranscribeBtn.title = !hasAudio
    ? 'No audio stored — re-transcribe is not available for this note'
    : retranscribeInFlight
      ? 'A re-transcribe run is already in progress'
      : 'Re-transcribe using the current model';
}

reTranscribeBtn.addEventListener('click', async () => {
  // D4 guard (a): a second trigger while a run is in flight is a no-op —
  // the button is disabled too, this is belt-and-braces for keyboard/programmatic clicks.
  if (!selectedNoteId || retranscribeInFlight) return;
  const requestedNoteId = selectedNoteId;
  retranscribeInFlight = true;
  syncReTranscribeButton();
  let result: { started: boolean; error?: string; runId?: number };
  try {
    result = await api.reTranscribe(requestedNoteId);
  } catch (err) {
    result = { started: false, error: String(err) };
  }
  if (!result.started) {
    retranscribeInFlight = false;
    syncReTranscribeButton();
    showError(result.error || 'Re-transcribe failed to start');
    return;
  }
  pendingTranscriptNoteId = requestedNoteId;
  updateStatusBar({ status: 'transcribing' });
});

deleteNoteBtn.addEventListener('click', async () => {
  if (!selectedNoteId) return;
  const note = notes.find(n => n.id === selectedNoteId);
  if (!confirm(`Delete "${note?.title || 'this note'}"? This cannot be undone.`)) return;
  await api.deleteNote(selectedNoteId);
  selectedNoteId = null;
  emptyState.hidden = false;
  noteDetail.hidden = true;
  await loadNotes();
});

// Dictation
dictationGrantBtn.addEventListener('click', async () => {
  await api.requestDictationAccess();
  const status = await api.getDictationStatus();
  applyDictationStatus(status);
});

// Settings
settingsBtn.addEventListener('click', openSettings);
settingsCloseBtn.addEventListener('click', closeSettings);
settingsSaveBtn.addEventListener('click', saveSettings);

pythonBrowseBtn.addEventListener('click', async () => {
  const p = await api.pickPythonFile();
  if (p) pythonPathInput.value = p;
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

cacheDirBrowseBtn.addEventListener('click', async () => {
  const p = await api.pickDirectory('Choose model cache directory');
  if (p) cacheDirInput.value = p;
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
  setHint(promptPathStatus, `Active model: ${activeModel}`, 'ok');
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
    div.className = 'hf-model-card';
    
    const title = document.createElement('h4');
    title.className = 'hf-model-id';
    title.textContent = item.filePath.split(/[/\\]/).pop() || item.filePath;
    div.appendChild(title);

    const statusP = document.createElement('p');
    statusP.className = 'hf-model-tags';
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
    acts.className = 'hf-actions';
    acts.appendChild(cancelBtn);
    div.appendChild(acts);

    importQueueList.appendChild(div);
  }
  
  if (importQueueList.children.length === 0) {
    importQueueSection.hidden = true;
  }
}

init().catch(console.error);
