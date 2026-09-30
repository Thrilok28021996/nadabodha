/**
 * IPC channel names and payload shapes shared between main and renderer.
 */

export enum IpcChannel {
  StartRecording = 'start-recording',
  StopRecording = 'stop-recording',
  ImportAudio = 'import-audio',
  CancelTranscription = 'cancel-transcription',
  SaveTranscript = 'save-transcript',
  CopyTranscript = 'copy-transcript',
  TranscriptionEvent = 'transcription-event',
  RequestStatus = 'request-status',
  SettingsGet = 'settings-get',
  SettingsSet = 'settings-set',
  ValidatePython = 'validate-python',
  PickDirectory = 'pick-directory',
  PickFile = 'pick-file',
  TestLlmConnection = 'test-llm-connection',
  ListHfModels = 'list-hf-models',
  DownloadModel = 'download-model',
  CancelDownload = 'cancel-download',
  Summarize = 'summarize',
  CancelSummary = 'cancel-summary',
  DictationStatus = 'dictation-status',
  DictationRequestAccess = 'dictation-request-access',
  // Stage 1: Note store
  ListNotes = 'list-notes',
  GetNote = 'get-note',
  CreateNote = 'create-note',
  UpdateNote = 'update-note',
  DeleteNote = 'delete-note',
  ReadNoteContent = 'read-note-content',
  ListFolders = 'list-folders',
  SearchNotes = 'search-notes',
  ReTranscribe = 're-transcribe',
  EnqueueImports = 'enqueue-imports',
  CancelImportItem = 'cancel-import-item',
  RemoveImportItem = 'remove-import-item',
  ImportQueueEvent = 'import-queue-event',
  PickWatchFolder = 'pick-watch-folder',
}

export interface ImportItem {
  id: string;
  filePath: string;
  progress: number;
  status: 'pending' | 'transcribing' | 'completed' | 'error' | 'cancelled';
  error?: string;
  text?: string;
}

export type TranscriptionStatus =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'downloading'
  | 'summarizing';

/**
 * Which workflow produced an event. Events without an origin are treated as
 * transcription events (the Python adapter does not set one for its classic
 * transcript events).
 */
export type EventOrigin = 'transcription' | 'download' | 'summary' | 'dictation';

export interface TranscriptionEvent {
  status: TranscriptionStatus;
  text?: string;
  progress?: number; // 0-100 when transcribing / downloading / summarizing
  error?: string;
  origin?: EventOrigin;
  /** Inline, non-error hint shown by the dictation UI (e.g. too-short take). */
  dictationNotice?: string;
  // Model download details
  repoId?: string;
  path?: string;
  file?: string;
  bytesDone?: number;
  bytesTotal?: number;
  partial?: boolean;
  // Auto-save results surfaced alongside the completed events
  savedTranscriptPath?: string;
  savedSummaryPath?: string;
  saveError?: string;
  // Word level timestamps
  words?: {word: string, start: number, end: number}[];
  /** D3: system-audio (catap) capture failed; the mic recording continues. */
  meetingError?: string;
  /**
   * D4: run token stamped by main onto every event of an in-flight
   * re-transcribe. The renderer routes completions by this note id, so a
   * completion can never land on a different note.
   */
  reTranscribeNoteId?: string;
  reTranscribeRunId?: number;
}

export interface StartRecordingRequest {
  meetingMode?: boolean;
}

export interface ImportAudioRequest {
  filePath: string;
}

export interface SaveTranscriptRequest {
  filePath: string;
  text: string;
  format?: 'txt' | 'srt' | 'vtt';
  words?: {word: string, start: number, end: number}[];
}

export interface SaveTranscriptResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

/** Persisted user settings (userData/settings.json). */
export interface AppSettings {
  /** Python interpreter used to run the adapter. Empty = fall back to
   *  NADABODHA_PYTHON, then `python3` on PATH. */
  pythonPath: string;
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:1234/v1 */
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  /** Root folder for transcripts/, summaries/ and scripts/. Empty = not set. */
  dataDir: string;
  /** Hugging Face model cache directory (model downloads land here). */
  sttCacheDir: string;
  summarizationEnabled: boolean;
  autoSummarize: boolean;
  /** Hugging Face repo id used as the primary STT model. Empty = fallback chain. */
  activeModel: string;
  /** Hold-Option system-wide dictation (workstream 3). Default ON. */
  dictationEnabled: boolean;
  /** Whether dictation pastes text at cursor. Default ON. OFF = append-in-app only. */
  dictationPasteEnabled?: boolean;
  meetingModeEnabled?: boolean;
  watchFolderDir?: string;
}

/** Live state of the hold-Option dictation hook. */
export interface DictationStatusInfo {
  /** False when uiohook-napi could not be loaded in the main process. */
  supported: boolean;
  /** The dictationEnabled setting. */
  enabled: boolean;
  /** systemPreferences.isTrustedAccessibilityClient(false). */
  accessibilityTrusted: boolean;
  /** True when the global key hook is actually listening. */
  running: boolean;
  /** Why the hook is not running ('disabled' | 'no-accessibility' | 'hook-error' | ...). */
  reason?: string;
}

export interface PythonValidation {
  /** True when the interpreter passed every check (including the import probe). */
  ok: boolean;
  /** True when the value must not be persisted (missing / not executable). */
  blocking: boolean;
  message: string;
}

export type HfRepoKind = 'ctranslate2' | 'pytorch' | 'unsupported';

export interface HfModelInfo {
  id: string;
  downloads: number;
  pipelineTag: string | null;
  tags: string[];
  kind: HfRepoKind;
  /** Human-readable explanation for unsupported models. */
  reason?: string;
  /** Short format label for the UI (e.g. "CTranslate2"). */
  format: string;
}

export interface HfModelListResult {
  models: HfModelInfo[];
  /** Snapshots that are complete and safe to activate. */
  installed: string[];
  /** Snapshots with files on disk whose download was interrupted. */
  partial?: string[];
  activeModel: string;
  error?: string;
}

export interface LlmConnectionResult {
  ok: boolean;
  models: string[];
  message: string;
}

export type SettingsFieldError = 'pythonPath' | 'dataDir' | 'sttCacheDir' | 'llm';

export interface SettingsUpdateResult {
  settings: AppSettings;
  errors: Partial<Record<SettingsFieldError, string>>;
  /** Inline, non-blocking messages (e.g. Python probe result). */
  messages?: Partial<Record<SettingsFieldError, string>>;
}

// ---------------------------------------------------------------------------
// Stage 1: Note store IPC types
// ---------------------------------------------------------------------------

export type NoteSource = 'recording' | 'import' | 'dictation-log' | 'unknown';

/** Serializable snapshot of a NoteRecord (dates as ISO strings). */
export interface NoteInfo {
  id: string;
  title: string;
  created: string; // ISO 8601
  source: NoteSource;
  folder: string;
  duration: number;
  model: string;
  transcribed_at?: string;
  hasAudio: boolean;
  summaryStale?: boolean;
}

export interface NoteContent {
  transcript: string;
  summary: string;
  words?: {word: string, start: number, end: number}[];
}

export interface NoteListResult {
  notes: NoteInfo[];
  folders: string[];
  folderCounts: Record<string, number>;
  error?: string;
}

export interface NoteGetResult {
  note?: NoteInfo;
  content?: NoteContent;
  error?: string;
}

export interface NoteCreateRequest {
  title?: string;
  source: NoteSource;
  folder?: string;
  transcript?: string;
  words?: {word: string, start: number, end: number}[];
}

export interface NoteUpdateRequest {
  id: string;
  title?: string;
  folder?: string;
  transcript?: string;
  summary?: string;
  model?: string;
  markSummaryStale?: boolean;
  clearSummaryStale?: boolean;
  words?: {word: string, start: number, end: number}[];
}

export interface NoteActionResult {
  success: boolean;
  note?: NoteInfo;
  error?: string;
}

export interface ReTranscribeRequest {
  noteId: string;
}

export interface ReTranscribeResult {
  started: boolean;
  error?: string;
  /** D4: token identifying this run (present when started). */
  runId?: number;
}
