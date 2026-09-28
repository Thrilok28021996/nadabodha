import { contextBridge, ipcRenderer } from 'electron';

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
}

type TranscriptionStatus =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'completed'
  | 'cancelled'
  | 'error';

interface TranscriptionEvent {
  status: TranscriptionStatus;
  text?: string;
  progress?: number;
  error?: string;
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
};

contextBridge.exposeInMainWorld('electronAPI', api);
