import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * IPC channel names and payload shapes, duplicated here so the preload
 * script does not depend on shared modules (sandboxed preload cannot
 * require files outside the preload script directory).
 */
enum IpcChannel {
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


type TranscriptionStatus =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'downloading'
  | 'summarizing';

type EventOrigin = 'transcription' | 'download' | 'summary' | 'dictation';

interface TranscriptionEvent {
  status: TranscriptionStatus;
  text?: string;
  progress?: number;
  error?: string;
  origin?: EventOrigin;
  dictationNotice?: string;
  repoId?: string;
  path?: string;
  file?: string;
  bytesDone?: number;
  bytesTotal?: number;
  savedTranscriptPath?: string;
  savedSummaryPath?: string;
  saveError?: string;
  partial?: boolean;
}

interface SaveTranscriptRequest {
  filePath: string;
  text: string;
  format?: 'txt' | 'srt' | 'vtt';
  words?: {word: string, start: number, end: number}[];
}

interface SaveTranscriptResult {
  success: boolean;
  filePath?: string;
  error?: string;
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

interface ImportItem {
  id: string;
  filePath: string;
  progress: number;
  status: 'pending' | 'transcribing' | 'completed' | 'error' | 'cancelled';
  error?: string;
  text?: string;
}

interface DictationStatusInfo {
  supported: boolean;
  enabled: boolean;
  accessibilityTrusted: boolean;
  running: boolean;
  reason?: string;
}

interface PythonValidation {
  ok: boolean;
  blocking: boolean;
  message: string;
}

interface SettingsUpdateResult {
  settings: AppSettings;
  errors: Partial<Record<string, string>>;
  messages?: Partial<Record<string, string>>;
}

interface LlmConnectionResult {
  ok: boolean;
  models: string[];
  message: string;
}

interface HfModelInfo {
  id: string;
  downloads: number;
  pipelineTag: string | null;
  tags: string[];
  kind: 'ctranslate2' | 'pytorch' | 'unsupported';
  reason?: string;
  format: string;
}

interface HfModelListResult {
  models: HfModelInfo[];
  installed: string[];
  activeModel: string;
  error?: string;
}

// Stage 1: Note store types (mirrored from shared/ipc.ts)
type NoteSource = 'recording' | 'import' | 'dictation-log' | 'unknown';

interface NoteInfo {
  id: string;
  title: string;
  created: string;
  source: NoteSource;
  folder: string;
  duration: number;
  model: string;
  transcribed_at?: string;
  hasAudio: boolean;
  summaryStale?: boolean;
}

interface NoteContent {
  transcript: string;
  summary: string;
  words?: {word: string, start: number, end: number}[];
}

interface NoteListResult {
  notes: NoteInfo[];
  folders: string[];
  folderCounts: Record<string, number>;
  error?: string;
}

interface NoteGetResult {
  note?: NoteInfo;
  content?: NoteContent;
  error?: string;
}

interface NoteCreateRequest {
  title?: string;
  source: NoteSource;
  folder?: string;
  transcript?: string;
}

interface NoteUpdateRequest {
  id: string;
  title?: string;
  folder?: string;
  transcript?: string;
  summary?: string;
  model?: string;
  markSummaryStale?: boolean;
  clearSummaryStale?: boolean;
}

interface NoteActionResult {
  success: boolean;
  note?: NoteInfo;
  error?: string;
}

export interface ElectronApi {
  startRecording: (options?: { meetingMode?: boolean }) => Promise<{ outputPath: string }>;
  stopRecording: () => Promise<{ outputPath: string | null }>;
  importAudio: (filePath: string) => Promise<{ filePath: string }>;
  cancelTranscription: () => Promise<{ cancelled: boolean }>;
  saveTranscript: (request: SaveTranscriptRequest) => Promise<SaveTranscriptResult>;
  copyTranscript: (text: string) => Promise<{ copied: boolean }>;
  requestStatus: () => Promise<{
    status: string;
    text: string;
    filePath: string | null;
  }>;
  requestSavePath: () => Promise<string | undefined>;
  onTranscriptionEvent: (callback: (event: TranscriptionEvent) => void) => void;
  removeTranscriptionListener: () => void;
  // Settings + summarization + model browser
  getSettings: () => Promise<AppSettings>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<SettingsUpdateResult>;
  validatePython: (pythonPath: string) => Promise<PythonValidation>;
  pickDirectory: (title?: string) => Promise<string | null>;
  pickPythonFile: () => Promise<string | null>;
  getPathForFile?: (file: File) => string;
  testLlmConnection: (baseUrl?: string) => Promise<LlmConnectionResult>;
  listHfModels: (query?: string) => Promise<HfModelListResult>;
  downloadModel: (repoId: string) => Promise<{ started: boolean; error?: string }>;
  cancelDownload: () => Promise<{ cancelled: boolean }>;
  summarize: (text?: string) => Promise<{ started: boolean; error?: string }>;
  cancelSummary: () => Promise<{ cancelled: boolean }>;
  // Dictation (hold Option)
  getDictationStatus: () => Promise<DictationStatusInfo>;
  requestDictationAccess: () => Promise<DictationStatusInfo>;
  // Stage 1: Note store
  listNotes: () => Promise<NoteListResult>;
  getNote: (id: string) => Promise<NoteGetResult>;
  createNote: (req: NoteCreateRequest) => Promise<NoteActionResult>;
  updateNote: (req: NoteUpdateRequest) => Promise<NoteActionResult>;
  deleteNote: (id: string) => Promise<NoteActionResult>;
  readNoteContent: (id: string) => Promise<NoteGetResult>;
  listFolders: () => Promise<{ folders: string[]; counts: Record<string, number> }>;
  searchNotes: (query: string) => Promise<NoteListResult>;
  reTranscribe: (noteId: string) => Promise<{ started: boolean; error?: string; runId?: number }>;
  // Stage 5
  pickWatchFolder: () => Promise<string | null>;
  enqueueImports: (filePaths: string[]) => Promise<string[]>;
  cancelImportItem: (id: string) => Promise<{cancelled: boolean}>;
  removeImportItem: (id: string) => Promise<{success: boolean}>;
  onImportQueueEvent: (callback: (queue: ImportItem[]) => void) => void;
  removeImportQueueListener: () => void;
}

const api: ElectronApi = {
  startRecording: (options) => ipcRenderer.invoke(IpcChannel.StartRecording, options),
  stopRecording: () => ipcRenderer.invoke(IpcChannel.StopRecording),
  importAudio: (filePath: string) => ipcRenderer.invoke(IpcChannel.ImportAudio, filePath),
  cancelTranscription: () => ipcRenderer.invoke(IpcChannel.CancelTranscription),
  saveTranscript: (request: SaveTranscriptRequest) =>
    ipcRenderer.invoke(IpcChannel.SaveTranscript, request),
  copyTranscript: (text: string) => ipcRenderer.invoke(IpcChannel.CopyTranscript, text),
  requestStatus: () => ipcRenderer.invoke(IpcChannel.RequestStatus),
  requestSavePath: () => ipcRenderer.invoke('request-save-path'),
  onTranscriptionEvent: (callback) => {
    ipcRenderer.removeAllListeners(IpcChannel.TranscriptionEvent);
    ipcRenderer.on(IpcChannel.TranscriptionEvent, (_event: unknown, value: TranscriptionEvent) => {
      callback(value);
    });
  },
  removeTranscriptionListener: () => {
    ipcRenderer.removeAllListeners(IpcChannel.TranscriptionEvent);
  },
  getSettings: () => ipcRenderer.invoke(IpcChannel.SettingsGet),
  updateSettings: (patch) => ipcRenderer.invoke(IpcChannel.SettingsSet, patch),
  validatePython: (pythonPath) => ipcRenderer.invoke(IpcChannel.ValidatePython, pythonPath),
  pickDirectory: (title) => ipcRenderer.invoke(IpcChannel.PickDirectory, title),
  pickPythonFile: () => ipcRenderer.invoke(IpcChannel.PickFile),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return (file as unknown as { path?: string }).path || '';
    }
  },
  testLlmConnection: (baseUrl) => ipcRenderer.invoke(IpcChannel.TestLlmConnection, baseUrl),
  listHfModels: (query) => ipcRenderer.invoke(IpcChannel.ListHfModels, query),
  downloadModel: (repoId) => ipcRenderer.invoke(IpcChannel.DownloadModel, repoId),
  cancelDownload: () => ipcRenderer.invoke(IpcChannel.CancelDownload),
  summarize: (text) => ipcRenderer.invoke(IpcChannel.Summarize, { text }),
  cancelSummary: () => ipcRenderer.invoke(IpcChannel.CancelSummary),
  getDictationStatus: () => ipcRenderer.invoke(IpcChannel.DictationStatus),
  requestDictationAccess: () => ipcRenderer.invoke(IpcChannel.DictationRequestAccess),
  listNotes: () => ipcRenderer.invoke(IpcChannel.ListNotes),
  getNote: (id) => ipcRenderer.invoke(IpcChannel.GetNote, id),
  createNote: (req) => ipcRenderer.invoke(IpcChannel.CreateNote, req),
  updateNote: (req) => ipcRenderer.invoke(IpcChannel.UpdateNote, req),
  deleteNote: (id) => ipcRenderer.invoke(IpcChannel.DeleteNote, id),
  readNoteContent: (id) => ipcRenderer.invoke(IpcChannel.ReadNoteContent, id),
  listFolders: () => ipcRenderer.invoke(IpcChannel.ListFolders),
  searchNotes: (query) => ipcRenderer.invoke(IpcChannel.SearchNotes, query),
  reTranscribe: (noteId) => ipcRenderer.invoke(IpcChannel.ReTranscribe, { noteId }),
  pickWatchFolder: () => ipcRenderer.invoke(IpcChannel.PickWatchFolder),
  enqueueImports: (filePaths) => ipcRenderer.invoke(IpcChannel.EnqueueImports, filePaths),
  cancelImportItem: (id) => ipcRenderer.invoke(IpcChannel.CancelImportItem, id),
  removeImportItem: (id) => ipcRenderer.invoke(IpcChannel.RemoveImportItem, id),
  onImportQueueEvent: (callback) => {
    ipcRenderer.removeAllListeners(IpcChannel.ImportQueueEvent);
    ipcRenderer.on(IpcChannel.ImportQueueEvent, (_event: unknown, queue: ImportItem[]) => {
      callback(queue);
    });
  },
  removeImportQueueListener: () => {
    ipcRenderer.removeAllListeners(IpcChannel.ImportQueueEvent);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);

