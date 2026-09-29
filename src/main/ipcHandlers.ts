import { app, BrowserWindow, dialog, ipcMain, clipboard } from 'electron';
import fs from 'fs';
import path from 'path';
import {
  IpcChannel,
  TranscriptionEvent,
  SaveTranscriptRequest,
  AppSettings,
  SettingsUpdateResult,
  PythonValidation,
  LlmConnectionResult,
  HfModelListResult,
} from '../shared/ipc';
import { isSupportedAudioFile } from '../shared/audioFormats';
import { AudioRecorder } from './audioRecorder';
import { ensureMicrophonePermission, MICROPHONE_DENIED_MESSAGE } from './micPermission';
import { TranscriptionService } from './transcriptionService';
import { saveTranscript } from './exportText';
import { SettingsStore, resolvePythonExecutable, validatePythonInterpreter } from './settingsStore';
import { ensureDataDirLayout, readPromptTemplate, saveSummaryToDataDir, saveTranscriptToDataDir } from './autoSave';
import { Summarizer, listLlmModels } from './summarizer';
import { ModelDownloadService } from './modelDownloadService';
import { classifyRepo, searchHfModels } from './hfModels';

export interface IpcSetupOptions {
  mainWindow: BrowserWindow;
  transcriptionService: TranscriptionService;
  recorder: AudioRecorder;
  settingsStore: SettingsStore;
}

type SettingsPatch = Partial<Record<keyof AppSettings, unknown>>;

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export function setupIpcHandlers(options: IpcSetupOptions): void {
  const { mainWindow, transcriptionService, recorder, settingsStore } = options;

  const emit = (event: TranscriptionEvent): void => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send(IpcChannel.TranscriptionEvent, event);
  };

  // ---- Summary orchestration -------------------------------------------------

  let summaryInFlight = false;

  const summarizer = new Summarizer((event) => {
    if (event.status === 'summarizing') {
      summaryInFlight = true;
    } else if (event.status === 'completed' || event.status === 'error' || event.status === 'cancelled') {
      summaryInFlight = false;
      // Auto-save the summary next to the transcript (never throws).
      if (event.status === 'completed' && event.text) {
        const settings = settingsStore.get();
        if (settings.dataDir) {
          const saved = saveSummaryToDataDir(settings.dataDir, event.text);
          if (saved.success) {
            emit({ ...event, savedSummaryPath: saved.filePath });
            return;
          }
          emit({ ...event, saveError: saved.error });
          return;
        }
      }
    }
    emit(event);
  });

  function runSummary(settings: AppSettings, transcript: string): void {
    const { template } = readPromptTemplate(settings.dataDir);
    void summarizer
      .summarize({
        baseUrl: settings.llmBaseUrl,
        model: settings.llmModel,
        apiKey: settings.llmApiKey,
        transcript,
        template,
      })
      .catch((err) => {
        summaryInFlight = false;
        emit({ status: 'error', origin: 'summary', error: describeError(err) });
      });
  }

  // ---- Model download -------------------------------------------------------

  const downloadService = new ModelDownloadService({
    pythonExecutable: () => resolvePythonExecutable(settingsStore.get()),
    onEvent: (event) => emit(event),
  });

  // ---- Transcription events (autosave + auto-summary) ------------------------

  transcriptionService.onEvent((event) => {
    if (event.origin === 'download' || event.origin === 'summary') {
      emit(event);
      return;
    }

    if (event.status !== 'completed') {
      emit(event);
      return;
    }

    const settings = settingsStore.get();
    const text = event.text || '';
    let withSaves: TranscriptionEvent = { ...event, origin: 'transcription' };

    if (settings.dataDir) {
      const saved = saveTranscriptToDataDir(settings.dataDir, text);
      if (saved.success) {
        withSaves = { ...withSaves, savedTranscriptPath: saved.filePath };
      } else {
        withSaves = { ...withSaves, saveError: saved.error };
      }
    }

    emit(withSaves);

    const llmConfigured =
      settings.llmBaseUrl.trim().length > 0 && settings.llmModel.trim().length > 0;
    if (
      settings.summarizationEnabled &&
      settings.autoSummarize &&
      llmConfigured &&
      text.trim() &&
      !summaryInFlight &&
      !summarizer.isRunning()
    ) {
      runSummary(settings, text);
    }
  });

  // ---- Existing handlers ----------------------------------------------------

  ipcMain.handle(IpcChannel.RequestStatus, async () => {
    return {
      status: transcriptionService.getState(),
      text: transcriptionService.getTranscript(),
      filePath: transcriptionService.getCurrentFilePath(),
    };
  });

  ipcMain.handle(IpcChannel.StartRecording, async () => {
    // Microphone permission first: a denial must never spawn ffmpeg (a
    // blocked capture device fails with a cryptic avfoundation error or a
    // hung device open). The guidance goes out on the same error-event route
    // recorder failures use, so the renderer shows it unchanged.
    const permission = await ensureMicrophonePermission();
    if (!permission.granted) {
      emit({ status: 'error', error: MICROPHONE_DENIED_MESSAGE });
      return { outputPath: null };
    }
    const outputPath = recorder.start();
    emit({ status: 'recording' });
    return { outputPath };
  });

  ipcMain.handle(IpcChannel.StopRecording, async () => {
    const outputPath = await recorder.stop();
    // N-F2: a null path, or one whose file never materialised, must never
    // reach transcription, where it surfaces as "File not found".
    const usable =
      typeof outputPath === 'string' && outputPath.length > 0 && fs.existsSync(outputPath);
    if (usable) {
      transcriptionService.startTranscription(outputPath);
    }
    return { outputPath: usable ? outputPath : null };
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

  // ---- Settings -------------------------------------------------------------

  ipcMain.handle(IpcChannel.SettingsGet, async (): Promise<AppSettings> => {
    return settingsStore.get();
  });

  ipcMain.handle(
    IpcChannel.SettingsSet,
    async (_event: unknown, rawPatch: SettingsPatch): Promise<SettingsUpdateResult> => {
      const patch: SettingsPatch = rawPatch && typeof rawPatch === 'object' ? rawPatch : {};
      const errors: SettingsUpdateResult['errors'] = {};
      const messages: SettingsUpdateResult['messages'] = {};
      const accepted: SettingsPatch = {};

      if (typeof patch.pythonPath === 'string') {
        const validation = await validatePythonInterpreter(patch.pythonPath);
        messages.pythonPath = validation.message;
        if (validation.blocking) {
          errors.pythonPath = validation.message;
        } else {
          accepted.pythonPath = patch.pythonPath.trim();
        }
      }

      for (const key of ['llmBaseUrl', 'llmModel', 'llmApiKey'] as const) {
        const value = patch[key];
        if (typeof value === 'string') {
          accepted[key] = value;
        }
      }

      if (typeof patch.dataDir === 'string') {
        const dir = patch.dataDir.trim();
        if (dir) {
          const layout = ensureDataDirLayout(dir);
          if (!layout.success) {
            errors.dataDir = layout.error;
          } else {
            accepted.dataDir = dir;
          }
        } else {
          accepted.dataDir = '';
        }
      }

      if (typeof patch.sttCacheDir === 'string') {
        const dir = patch.sttCacheDir.trim();
        if (dir) {
          try {
            fs.mkdirSync(dir, { recursive: true });
            accepted.sttCacheDir = dir;
          } catch (err) {
            errors.sttCacheDir = `Cannot use cache directory ${dir}: ${describeError(err)}`;
          }
        } else {
          accepted.sttCacheDir = '';
        }
      }

      if (typeof patch.summarizationEnabled === 'boolean') {
        accepted.summarizationEnabled = patch.summarizationEnabled;
      }
      if (typeof patch.autoSummarize === 'boolean') {
        accepted.autoSummarize = patch.autoSummarize;
      }
      if (typeof patch.activeModel === 'string') {
        accepted.activeModel = patch.activeModel.trim();
      }

      try {
        return { settings: settingsStore.update(accepted), errors, messages };
      } catch (err) {
        return {
          settings: settingsStore.get(),
          errors: { ...errors, llm: `Cannot write settings: ${describeError(err)}` },
          messages,
        };
      }
    }
  );

  ipcMain.handle(IpcChannel.ValidatePython, async (_event: unknown, pythonPath: string): Promise<PythonValidation> => {
    return validatePythonInterpreter(typeof pythonPath === 'string' ? pythonPath : '');
  });

  ipcMain.handle(IpcChannel.PickDirectory, async (_event: unknown, title?: string) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: typeof title === 'string' && title ? title : 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(IpcChannel.PickFile, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a Python interpreter',
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // ---- Local LLM ------------------------------------------------------------

  ipcMain.handle(
    IpcChannel.TestLlmConnection,
    async (_event: unknown, baseUrl?: string): Promise<LlmConnectionResult> => {
      const settings = settingsStore.get();
      const target = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl : settings.llmBaseUrl;
      return listLlmModels(target);
    }
  );

  // ---- Hugging Face model browser ------------------------------------------

  ipcMain.handle(
    IpcChannel.ListHfModels,
    async (_event: unknown, query?: string): Promise<HfModelListResult> => {
      const settings = settingsStore.get();
      return searchHfModels(
        typeof query === 'string' ? query : '',
        settings.sttCacheDir,
        settings.activeModel
      );
    }
  );

  ipcMain.handle(
    IpcChannel.DownloadModel,
    async (_event: unknown, repoId?: string): Promise<{ started: boolean; error?: string }> => {
      const id = typeof repoId === 'string' ? repoId.trim() : '';
      if (!id) {
        return { started: false, error: 'No model selected' };
      }
      const classification = classifyRepo({ id });
      if (classification.kind === 'unsupported') {
        return { started: false, error: classification.reason || `${id} cannot run locally as STT` };
      }
      const settings = settingsStore.get();
      if (!settings.sttCacheDir.trim()) {
        return { started: false, error: 'No model cache directory configured' };
      }
      return downloadService.start(id, settings.sttCacheDir);
    }
  );

  ipcMain.handle(IpcChannel.CancelDownload, async () => {
    return downloadService.cancel();
  });

  // ---- Summarization --------------------------------------------------------

  ipcMain.handle(
    IpcChannel.Summarize,
    async (_event: unknown, request?: { text?: string }): Promise<{ started: boolean; error?: string }> => {
      const settings = settingsStore.get();
      if (!settings.summarizationEnabled) {
        return { started: false, error: 'Summarization is disabled in Settings' };
      }
      if (summaryInFlight || summarizer.isRunning()) {
        return { started: false, error: 'A summary is already running' };
      }
      const text =
        request && typeof request.text === 'string' && request.text.trim()
          ? request.text
          : transcriptionService.getTranscript();
      if (!text.trim()) {
        return { started: false, error: 'Nothing to summarize: the transcript is empty' };
      }
      runSummary(settings, text);
      return { started: true };
    }
  );

  ipcMain.handle(IpcChannel.CancelSummary, async () => {
    summarizer.cancel();
    return { cancelled: true };
  });

  // ---- Recorder failure forwarding -----------------------------------------

  // Forward recorder failures (e.g. ffmpeg missing or crashing) to the
  // renderer. Without a listener, EventEmitter rethrows 'error' and Node
  // reports an uncaught exception that takes the main process down (F5).
  recorder.on('error', (err: Error) => {
    emit({ status: 'error', error: err.message });
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
