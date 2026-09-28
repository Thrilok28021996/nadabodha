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
export type EventOrigin = 'transcription' | 'download' | 'summary';

export interface TranscriptionEvent {
  status: TranscriptionStatus;
  text?: string;
  progress?: number; // 0-100 when transcribing / downloading / summarizing
  error?: string;
  origin?: EventOrigin;
  // Model download details
  repoId?: string;
  path?: string;
  file?: string;
  bytesDone?: number;
  bytesTotal?: number;
  // Auto-save results surfaced alongside the completed events
  savedTranscriptPath?: string;
  savedSummaryPath?: string;
  saveError?: string;
}

export interface ImportAudioRequest {
  filePath: string;
}

export interface SaveTranscriptRequest {
  filePath: string;
  text: string;
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
  installed: string[];
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
