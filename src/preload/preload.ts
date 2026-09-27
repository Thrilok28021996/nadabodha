import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannel,
  TranscriptionEvent,
  SaveTranscriptRequest,
  SaveTranscriptResult,
} from '../shared/ipc';

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
