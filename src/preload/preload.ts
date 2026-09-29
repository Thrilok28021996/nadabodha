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

type EventOrigin = 'transcription' | 'download' | 'summary';

interface TranscriptionEvent {
  status: TranscriptionStatus;
  text?: string;
  progress?: number;
  error?: string;
  origin?: EventOrigin;
  repoId?: string;
  path?: string;
  file?: string;
  bytesDone?: number;
  bytesTotal?: number;
  savedTranscriptPath?: string;
  savedSummaryPath?: string;
  saveError?: string;
}

interface SaveTranscriptRequest {
  filePath: string;
  text: string;
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

export interface ElectronApi {
  startRecording: () => Promise<{ outputPath: string }>;
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
}

const api: ElectronApi = {
  startRecording: () => ipcRenderer.invoke(IpcChannel.StartRecording),
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
};

contextBridge.exposeInMainWorld('electronAPI', api);
