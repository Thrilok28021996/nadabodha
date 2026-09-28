import { app, BrowserWindow, dialog, ipcMain, clipboard } from 'electron';
import fs from 'fs';
import path from 'path';
import {
  IpcChannel,
  TranscriptionEvent,
  SaveTranscriptRequest,
} from '../shared/ipc';
import { isSupportedAudioFile } from '../shared/audioFormats';
import { AudioRecorder } from './audioRecorder';
import { TranscriptionService } from './transcriptionService';
import { saveTranscript } from './exportText';

export interface IpcSetupOptions {
  mainWindow: BrowserWindow;
  transcriptionService: TranscriptionService;
  recorder: AudioRecorder;
}

export function setupIpcHandlers(options: IpcSetupOptions): void {
  const { mainWindow, transcriptionService, recorder } = options;

  ipcMain.handle(IpcChannel.RequestStatus, async () => {
    return {
      status: transcriptionService.getState(),
      text: transcriptionService.getTranscript(),
      filePath: transcriptionService.getCurrentFilePath(),
    };
  });

  ipcMain.handle(IpcChannel.StartRecording, async () => {
    const outputPath = recorder.start();
    mainWindow.webContents.send(IpcChannel.TranscriptionEvent, {
      status: 'recording',
    } as TranscriptionEvent);
    return { outputPath };
  });

  ipcMain.handle(IpcChannel.StopRecording, async () => {
    const outputPath = await recorder.stop();
    if (outputPath) {
      transcriptionService.startTranscription(outputPath);
    }
    return { outputPath };
  });

  ipcMain.handle(IpcChannel.ImportAudio, async (_event: unknown, filePath: string) => {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('filePath is required');
    }
    if (!isSupportedAudioFile(filePath)) {
      throw new Error(`Unsupported audio format: ${filePath}`);
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    transcriptionService.startTranscription(filePath);
    return { filePath };
  });

  ipcMain.handle(IpcChannel.CancelTranscription, async () => {
    transcriptionService.cancel();
    recorder.cancel();
    return { cancelled: true };
  });

  ipcMain.handle(IpcChannel.SaveTranscript, async (_event: unknown, request: SaveTranscriptRequest) => {
    return saveTranscript(request);
  });

  ipcMain.handle('request-save-path', async () => {
    return showSaveTranscriptDialog(mainWindow);
  });

  ipcMain.handle(IpcChannel.CopyTranscript, async (_event: unknown, text: string) => {
    clipboard.writeText(text || '');
    return { copied: true };
  });

  transcriptionService.onEvent((event) => {
    mainWindow.webContents.send(IpcChannel.TranscriptionEvent, event);
  });

  // Forward recorder failures (e.g. ffmpeg missing or crashing) to the
  // renderer. Without a listener, EventEmitter rethrows 'error' and Node
  // reports an uncaught exception that takes the main process down (F5).
  recorder.on('error', (err: Error) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send(IpcChannel.TranscriptionEvent, {
      status: 'error',
      error: err.message,
    } as TranscriptionEvent);
  });
}

export function showSaveTranscriptDialog(mainWindow: BrowserWindow): string | undefined {
  const result = dialog.showSaveDialogSync(mainWindow, {
    defaultPath: path.join(app.getPath('documents'), 'transcript.txt'),
    filters: [{ name: 'Plain Text', extensions: ['txt'] }],
    properties: ['createDirectory'],
  });
  return result;
}
