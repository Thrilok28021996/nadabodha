import { app, BrowserWindow, dialog, ipcMain, clipboard, systemPreferences, globalShortcut, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import {
  IpcChannel,
  TranscriptionEvent,
  StartRecordingRequest,
  SaveTranscriptRequest,
  AppSettings,
  SettingsUpdateResult,
  PythonValidation,
  LlmConnectionResult,
  HfModelListResult,
  DictationStatusInfo,
  NoteInfo,
  NoteListResult,
  NoteGetResult,
  NoteCreateRequest,
  NoteUpdateRequest,
  NoteActionResult,
  ReTranscribeRequest,
  ReTranscribeResult,
  CleanOldAudioResult,
} from '../shared/ipc';
import { isSupportedAudioFile } from '../shared/audioFormats';
import { AudioRecorder } from './audioRecorder';
import {
  ensureMicrophonePermission,
  ensureScreenPermission,
  MICROPHONE_DENIED_MESSAGE,
  SCREEN_DENIED_MESSAGE,
} from './micPermission';
import { TranscriptionService } from './transcriptionService';
import { saveTranscript } from './exportText';
import {
  SettingsStore,
  resolvePythonExecutable,
  validatePythonInterpreter,
  resolvePromptTemplate,
  DEFAULT_RECORDING_SHORTCUT,
  normalizeAccelerator,
} from './settingsStore';
import { ensureDataDirLayout, saveSummaryToDataDir, saveTranscriptToDataDir, SCRIPTS_DIR, PROMPT_TEMPLATE_FILE } from './autoSave';
import { Summarizer, listLlmModels } from './summarizer';
import { ModelDownloadService } from './modelDownloadService';
import { classifyRepo, searchHfModels } from './hfModels';
import {
  CHORD_NOTICE,
  DictationController,
  DictationHook,
  DictationTakeReason,
  TOO_SHORT_NOTICE,
} from './dictation';
import { NoteStore, NoteRecord, extractTagsAndFolder } from './noteStore';
import { pasteTextAtCursor } from './paste';
import { ImportQueue } from './importQueue';
import { WatchFolder } from './watchFolder';

export interface IpcSetupOptions {
  mainWindow: BrowserWindow;
  transcriptionService: TranscriptionService;
  recorder: AudioRecorder;
  settingsStore: SettingsStore;
  noteStore: NoteStore;
}

export interface IpcSetupResult {
  /** Null when uiohook-napi could not be loaded in the main process. */
  dictation: DictationController | null;
  /** Apply or update the global recording shortcut. */
  applyRecordingShortcut: (shortcut: string) => { success: boolean; error?: string };
}

/** Convert a NoteRecord to the serializable NoteInfo sent over IPC. */
function toNoteInfo(record: NoteRecord): NoteInfo {
  return {
    id: record.id,
    title: record.title,
    created: record.created.toISOString(),
    source: record.source,
    folder: record.folder,
    tags: record.tags || [],
    duration: record.duration,
    model: record.model,
    transcribed_at: record.transcribed_at?.toISOString(),
    hasAudio: !!record.audio,
    summaryStale: record.summaryStale,
  };
}

type SettingsPatch = Partial<Record<keyof AppSettings, unknown>>;

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Accessibility check behind the dictation crash guard: libuiohook installs a
 * macOS event tap that takes the process down when the app is not trusted, so
 * this is consulted BEFORE the hook starts.
 *
 * NADABODHA_DICTATION_NO_ACCESSIBILITY=1 forces the "not trusted" branch. It
 * exists so the banner + no-start path can be exercised without revoking the
 * machine's TCC grant (which can only be restored by a human clicking the
 * system prompt).
 */
export function isAccessibilityTrusted(ask = false): boolean {
  if (process.env.NADABODHA_DICTATION_NO_ACCESSIBILITY === '1') {
    return false;
  }
  try {
    return systemPreferences.isTrustedAccessibilityClient(ask);
  } catch {
    return false;
  }
}

/**
 * Loads the global input hook. A missing or broken native module disables
 * dictation instead of taking the app down.
 */
export function loadDictationHook(): DictationHook | null {
  try {
    // Optional native dependency: a load failure must disable dictation, not
    // the app, so it is required behind a try/catch instead of imported.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('uiohook-napi') as { uIOhook?: DictationHook };
    return mod && mod.uIOhook ? mod.uIOhook : null;
  } catch {
    return null;
  }
}

export function setupIpcHandlers(options: IpcSetupOptions): IpcSetupResult {
  const { mainWindow, transcriptionService, recorder, settingsStore, noteStore } = options;

  const emit = (event: TranscriptionEvent): void => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send(IpcChannel.TranscriptionEvent, event);
  };

  const importQueue = new ImportQueue(transcriptionService);
  let watchFolder: WatchFolder | null = null;

  // ---- Re-transcribe run bookkeeping (D4) ---------------------------------
  // At most one re-transcribe may be in flight. The note id is stamped onto
  // every event the run produces, so the renderer routes the completion by
  // the token this process issued — the renderer's single slot can never
  // cross notes, even if it is overwritten. The run clears itself on the
  // terminal status of the run it belongs to.
  let reTranscribeRun: { noteId: string; runId: number } | null = null;
  let reTranscribeRunSeq = 0;

  const stampReTranscribe = (event: TranscriptionEvent): TranscriptionEvent => {
    if (
      !reTranscribeRun ||
      event.origin === 'download' ||
      event.origin === 'summary' ||
      event.origin === 'dictation'
    ) {
      return event;
    }
    const stamped: TranscriptionEvent = {
      ...event,
      reTranscribeNoteId: reTranscribeRun.noteId,
      reTranscribeRunId: reTranscribeRun.runId,
    };
    if (
      event.status === 'completed' ||
      event.status === 'error' ||
      event.status === 'cancelled' ||
      event.status === 'idle'
    ) {
      reTranscribeRun = null;
    }
    return stamped;
  };

  importQueue.onEvent = (queue) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannel.ImportQueueEvent, queue);
    }
  };

  const applyWatchFolderSetting = () => {
    const dir = settingsStore.get().watchFolderDir;
    if (watchFolder) {
      watchFolder.stop();
      watchFolder = null;
    }
    if (dir) {
      watchFolder = new WatchFolder(dir, importQueue);
      watchFolder.start();
    }
  };
  applyWatchFolderSetting();

  // ---- Global Recording Shortcut Manager ---------------------------------
  let currentRecordingShortcut = settingsStore.get().recordingShortcut || DEFAULT_RECORDING_SHORTCUT;

  const applyRecordingShortcut = (shortcut: string): { success: boolean; error?: string } => {
    const raw = (shortcut || '').trim();
    if (!raw) {
      if (currentRecordingShortcut) {
        try {
          globalShortcut.unregister(currentRecordingShortcut);
        } catch { /* ignore */ }
        currentRecordingShortcut = '';
      }
      return { success: true };
    }

    const normalized = normalizeAccelerator(raw);

    // Space alone is strictly prohibited as a keybind
    if (normalized.toLowerCase() === 'space' || raw.toLowerCase() === 'space') {
      return {
        success: false,
        error: 'Space alone cannot be used as a keybinding. Please use a combination with modifiers (e.g. CommandOrControl+Shift+R).',
      };
    }

    try {
      if (currentRecordingShortcut) {
        try {
          globalShortcut.unregister(currentRecordingShortcut);
        } catch { /* ignore */ }
      }
      const registered = globalShortcut.register(normalized, () => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('toggle-recording');
        }
      });
      if (!registered) {
        // Attempt to restore previous shortcut if valid
        if (currentRecordingShortcut && currentRecordingShortcut !== normalized) {
          try {
            globalShortcut.register(currentRecordingShortcut, () => {
              if (!mainWindow.isDestroyed()) {
                mainWindow.webContents.send('toggle-recording');
              }
            });
          } catch { /* ignore */ }
        }
        return {
          success: false,
          error: `Could not register shortcut "${normalized}". It may already be in use by another application.`,
        };
      }
      currentRecordingShortcut = normalized;
      return { success: true };
    } catch (err) {
      if (currentRecordingShortcut && currentRecordingShortcut !== normalized) {
        try {
          globalShortcut.register(currentRecordingShortcut, () => {
            if (!mainWindow.isDestroyed()) {
              mainWindow.webContents.send('toggle-recording');
            }
          });
        } catch { /* ignore */ }
      }
      return {
        success: false,
        error: `Invalid shortcut accelerator "${raw}": ${(err as Error).message}`,
      };
    }
  };

  // Register initial global shortcut
  applyRecordingShortcut(currentRecordingShortcut);

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

  /**
   * Upper bound on generated tokens for a summary. Local reasoning models
   * otherwise keep emitting hidden reasoning until the context is exhausted,
   * which pushes a single summary past the summarizer's own 300s timeout.
   * Measured on the bundled test model: ~600 reasoning + ~400 answer tokens.
   */
  const SUMMARY_MAX_TOKENS = 4096;
  /**
   * System-level instruction for local reasoning models: without it they can
   * burn the whole token budget on hidden reasoning before answering (it
   * roughly halves reasoning tokens for the bundled test model).
   */
  const SUMMARY_SYSTEM_PROMPT =
    'You are a local summarization assistant. Reply with the Markdown summary only: no preamble and no commentary.';

  function runSummary(
    settings: AppSettings,
    transcript: string,
    promptId?: string,
    customTemplate?: string
  ): void {
    let template = customTemplate;
    if (!template) {
      const resolved = resolvePromptTemplate(settings, promptId);
      template = resolved.template;
    }
    void summarizer
      .summarize({
        baseUrl: settings.llmBaseUrl,
        model: settings.llmModel,
        apiKey: settings.llmApiKey,
        transcript,
        template,
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        maxTokens: SUMMARY_MAX_TOKENS,
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

  // ---- Dictation (hold Option, system-wide) ---------------------------------

  /**
   * Take bookkeeping. `dictationTakeId` is bumped by every abort so a take
   * whose microphone permission check is still in flight can never start
   * recording after it was cancelled.
   */
  let dictationTakeId = 0;
  let dictationStartPromise: Promise<void> | null = null;
  let dictationTakeOpen = false;

  const startDictationTake = (): void => {
    const id = ++dictationTakeId;
    dictationTakeOpen = true;
    const pending = (async () => {
      const permission = await ensureMicrophonePermission();
      if (id !== dictationTakeId) return; // aborted while waiting
      if (!permission.granted) {
        dictationTakeOpen = false;
        emit({ status: 'error', origin: 'dictation', error: MICROPHONE_DENIED_MESSAGE });
        return;
      }
      try {
        recorder.start();
        const stream = recorder.getStream();
        if (stream) {
          transcriptionService.startStreaming(stream, { origin: 'dictation' });
        }
      } catch (err) {
        if (id !== dictationTakeId) return;
        dictationTakeOpen = false;
        emit({ status: 'error', origin: 'dictation', error: describeError(err) });
        return;
      }
      if (id !== dictationTakeId) {
        // Aborted between the permission check and the actual start.
        recorder.cancel();
        return;
      }
      emit({ status: 'recording', origin: 'dictation' });
    })();
    dictationStartPromise = pending;
    void pending
      .catch(() => undefined)
      .then(() => {
        if (dictationStartPromise === pending) dictationStartPromise = null;
      });
  };

  const abortDictationTake = (reason: DictationTakeReason): void => {
    dictationTakeId += 1; // invalidate an in-flight start
    dictationTakeOpen = false;
    recorder.cancel();
    emit({
      status: 'idle',
      origin: 'dictation',
      // 'hook-stopped' (hook went away with the take open) carries no inline
      // notice: neither approved hint string applies to it.
      dictationNotice:
        reason === 'too-short' ? TOO_SHORT_NOTICE : reason === 'chord' ? CHORD_NOTICE : undefined,
    });
  };

  const finishDictationTake = (_heldMs: number): void => {
    const pending = dictationStartPromise;
    void (async () => {
      if (pending) await pending.catch(() => undefined);
      // Cancel streaming BEFORE the recorder stops — same EOF race as
      // StopRecording: the streaming child's own "completed" must not beat
      // the file pass (it would append the take twice).
      transcriptionService.cancel();
      const outputPath = await recorder.stop();
      dictationTakeOpen = false;
      const usable =
        outputPath && typeof outputPath.micPath === 'string' && outputPath.micPath.length > 0 && fs.existsSync(outputPath.micPath);
      if (usable) {
        // Dictation transcribes ONLY this take's audio so cursor paste gets
        // strictly the freshly spoken words.
        transcriptionService.startTranscription(outputPath, {
          origin: 'dictation',
        });
      } else {
        emit({ status: 'idle', origin: 'dictation' });
      }
    })().catch((err) => {
      dictationTakeOpen = false;
      emit({ status: 'error', origin: 'dictation', error: describeError(err) });
    });
  };

  /** Refuses a dictation take while the app is already recording/transcribing. */
  const canStartDictationTake = (): boolean => {
    if (dictationTakeOpen) return false;
    if (recorder.getState().status === 'recording') return false;
    const state = transcriptionService.getState();
    return state !== 'transcribing' && state !== 'recording';
  };

  const hook = loadDictationHook();
  const dictation = hook
    ? new DictationController({
        hook,
        actions: {
          startTake: startDictationTake,
          abortTake: abortDictationTake,
          finishTake: finishDictationTake,
        },
        isDictationEnabled: () => settingsStore.get().dictationEnabled !== false,
        isTrustedAccessibilityClient: isAccessibilityTrusted,
        canStartTake: canStartDictationTake,
      })
    : null;

  const applyDictationSetting = (): void => {
    if (!dictation) return;
    if (settingsStore.get().dictationEnabled !== false) {
      const result = dictation.start();
      if (!result.started && result.outcome === 'hook-error') {
        // Non-fatal: dictation is unavailable, the rest of the app is not.
        console.error(`dictation hook failed to start: ${result.error || result.outcome}`);
      }
    } else if (dictation.isRunning()) {
      dictation.stop();
    }
  };

  const dictationStatus = (): DictationStatusInfo => {
    // Every status poll attempts reconcileAccessibility(). reconcileAccessibility()
    // calls start() unconditionally when not running; start() has the live trust
    // check inside it. If the hook starts, lastOutcome becomes 'started'.
    // We then derive accessibilityTrusted from lastOutcome rather than calling
    // isAccessibilityTrusted() again — the probe approach caused uiohook singleton
    // conflicts and returned false even after the user granted permission.
    dictation?.reconcileAccessibility();
    const enabled = settingsStore.get().dictationEnabled !== false;
    const running = dictation !== null && dictation.isRunning();
    // 'no-accessibility' means trust was explicitly denied by the OS crash guard.
    // Every other outcome (started, disabled, hook-error, already-running) means
    // the OS allowed us past the trust check, so the banner must be hidden.
    const lastOutcome = dictation?.getLastOutcome();
    const accessibilityTrusted = running || (lastOutcome !== undefined && lastOutcome !== 'no-accessibility');
    let reason: string | undefined;
    if (!dictation) reason = 'uiohook-napi failed to load';
    else if (!enabled) reason = 'disabled';
    else if (!accessibilityTrusted) reason = 'no-accessibility';
    else if (!running) reason = dictation.getLastOutcome();
    return {
      supported: dictation !== null,
      enabled,
      accessibilityTrusted,
      running,
      reason,
    };
  };

  // ---- Transcription events (autosave + auto-summary) ------------------------

  transcriptionService.onEvent(async (rawEvent) => {
    // D4: stamp the re-transcribe run token before anything else sees the
    // event, and clear the run on its terminal status.
    const event = stampReTranscribe(rawEvent);
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

    let dictationNotice: string | undefined;

    // Stage 2: Dictation insert-at-cursor
    if (event.origin === 'dictation' && settings.dictationPasteEnabled !== false && text) {
      const pasteResult = await pasteTextAtCursor(text).catch(err => {
        console.error('[paste] failed', err);
        return 'error' as const;
      });
      
      if (pasteResult === 'secure-input') {
        dictationNotice = 'Skipped paste (Secure Input active)';
      } else if (pasteResult === 'error') {
        dictationNotice = 'Paste failed, saved to log';
      }
    }

    let withSaves: TranscriptionEvent = {
      ...event,
      origin: event.origin === 'dictation' ? 'dictation' : 'transcription',
      ...(dictationNotice ? { dictationNotice } : {})
    };

    if (event.origin !== 'dictation' && settings.dataDir) {
      const extracted = extractTagsAndFolder(text);
      if (extracted.tags.length > 0) {
        withSaves = { ...withSaves, tags: extracted.tags };
      }
      const saved = saveTranscriptToDataDir(settings.dataDir, text, extracted.folder);
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
      event.origin !== 'dictation' &&
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

  ipcMain.handle(IpcChannel.StartRecording, async (_event: unknown, request?: StartRecordingRequest) => {
    // If already recording, return the current output path safely instead of throwing
    if (recorder.getState().status === 'recording' || recorder.getStream()) {
      return { outputPath: recorder.getState().outputPath || '' };
    }
    // If transcription is currently in progress, reject recording start gracefully
    if (transcriptionService.getState() === 'transcribing') {
      return { outputPath: null, error: 'Transcription in progress. Please wait for it to finish.' };
    }
    // Microphone permission first: a denial must never spawn ffmpeg (a
    // blocked capture device fails with a cryptic avfoundation error or a
    // hung device open). The guidance goes out on the same error-event route
    // recorder failures use, so the renderer shows it unchanged.
    const permission = await ensureMicrophonePermission();
    if (!permission.granted) {
      emit({ status: 'error', error: MICROPHONE_DENIED_MESSAGE });
      return { outputPath: null };
    }
    
    if (request?.meetingMode) {
      const screenPerm = await ensureScreenPermission();
      if (!screenPerm.granted) {
        emit({ status: 'error', error: SCREEN_DENIED_MESSAGE });
        return { outputPath: null };
      }
    }
    
    const paths = recorder.start({ meetingMode: request?.meetingMode });
    const stream = recorder.getStream();
    if (stream) {
      try {
        transcriptionService.startStreaming(stream, { origin: 'transcription' });
      } catch (err) {
        console.warn('[StartRecording] startStreaming preview failed:', err);
      }
    }
    emit({ status: 'recording' });
    return { outputPath: paths.micPath };
  });

  ipcMain.handle(IpcChannel.StopRecording, async () => {
    // Commit stop: kill the streaming pass FIRST. Once the recorder stops,
    // python sees stdin EOF and reports "completed" on its own — racing the
    // file pass (a second note) or leaving a stale child that signals into
    // the run that replaces it. cancel() is state-guarded and idempotent.
    transcriptionService.cancel();
    const paths = await recorder.stop();
    // N-F2: a null path, or one whose file never materialised, must never
    // reach transcription, where it surfaces as "File not found".
    const usable = paths && typeof paths.micPath === 'string' && paths.micPath.length > 0 && fs.existsSync(paths.micPath);
    if (usable) {
      transcriptionService.startTranscription(paths);
    }
    return { outputPath: usable ? paths.micPath : null };
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

      if (typeof patch.watchFolderDir === 'string') {
        const dir = patch.watchFolderDir.trim();
        if (dir) {
           accepted.watchFolderDir = dir;
        } else {
           accepted.watchFolderDir = '';
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
      if (typeof patch.dictationEnabled === 'boolean') {
        accepted.dictationEnabled = patch.dictationEnabled;
      }
      if (typeof patch.dictationPasteEnabled === 'boolean') {
        accepted.dictationPasteEnabled = patch.dictationPasteEnabled;
      }
      if (typeof patch.meetingModeEnabled === 'boolean') {
        accepted.meetingModeEnabled = patch.meetingModeEnabled;
      }
      if (typeof patch.defaultPromptId === 'string' && patch.defaultPromptId.trim()) {
        accepted.defaultPromptId = patch.defaultPromptId.trim();
      }
      if (Array.isArray(patch.customPrompts)) {
        accepted.customPrompts = patch.customPrompts;
      }
      if (typeof patch.recordingShortcut === 'string') {
        const candidate = patch.recordingShortcut.trim();
        const shortcutToApply = candidate || DEFAULT_RECORDING_SHORTCUT;
        const res = applyRecordingShortcut(shortcutToApply);
        if (!res.success) {
          errors.recordingShortcut = res.error;
        } else {
          accepted.recordingShortcut = shortcutToApply;
        }
      }

      if (typeof patch.audioRetentionDays === 'number' || typeof (patch as any).audioRetentionDays === 'string') {
        const val = typeof patch.audioRetentionDays === 'number'
          ? patch.audioRetentionDays
          : parseInt((patch as any).audioRetentionDays, 10);
        if (!Number.isNaN(val)) {
          accepted.audioRetentionDays = Math.max(0, val);
          if (val > 0) {
            try {
              noteStore.deleteOldAudioRecordings(val);
            } catch (err) {
              console.error('[AudioRetention] Cleanup on settings change failed:', err);
            }
          }
        }
      }

      try {
        const settings = settingsStore.update(accepted);
        const activeDataDir = settings.dataDir;
        if (activeDataDir) {
          try {
            const resolved = resolvePromptTemplate(settings);
            const promptPath = path.join(activeDataDir, SCRIPTS_DIR, PROMPT_TEMPLATE_FILE);
            if (fs.existsSync(path.dirname(promptPath))) {
              fs.writeFileSync(promptPath, resolved.template, 'utf8');
            }
          } catch {
            // Non-blocking sync to dataDir/scripts/summarize-prompt.md
          }
        }
        if (typeof patch.dataDir === 'string' && !errors.dataDir) {
          // The vault follows a dataDir change (noteStore only reads the dir
          // it was constructed with, so without this new notes land in the
          // boot-time directory and the list keeps showing the old vault).
          noteStore.setDataDir(
            settings.dataDir ||
              path.join(app.getPath('userData'), 'nadabodha-data'),
          );
        }
        if (typeof patch.dictationEnabled === 'boolean') {
          // Start/stop the global hook immediately so the setting is live
          // without restarting the app.
          applyDictationSetting();
        }
        if (typeof patch.watchFolderDir === 'string') {
          applyWatchFolderSetting();
        }
        return { settings, errors, messages };
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

  ipcMain.handle(IpcChannel.PickWatchFolder, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Watch Folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(IpcChannel.EnqueueImports, async (_event: unknown, filePaths: string[]) => {
    const ids: string[] = [];
    for (const p of filePaths) {
      ids.push(importQueue.add(p));
    }
    return ids;
  });

  ipcMain.handle(IpcChannel.CancelImportItem, async (_event: unknown, id: string) => {
    importQueue.cancel(id);
    return { cancelled: true };
  });

  ipcMain.handle(IpcChannel.RemoveImportItem, async (_event: unknown, id: string) => {
    importQueue.remove(id);
    return { success: true };
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
    async (
      _event: unknown,
      request?: { text?: string; promptId?: string; template?: string }
    ): Promise<{ started: boolean; error?: string }> => {
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
      runSummary(settings, text, request?.promptId, request?.template);
      return { started: true };
    }
  );

  ipcMain.handle(IpcChannel.CancelSummary, async () => {
    summarizer.cancel();
    return { cancelled: true };
  });

  // ---- Dictation status -----------------------------------------------------

  ipcMain.handle(
    IpcChannel.DictationStatus,
    async (): Promise<DictationStatusInfo> => dictationStatus()
  );

  ipcMain.handle(
    IpcChannel.DictationRequestAccess,
    async (): Promise<DictationStatusInfo> => {
      // ask === true shows the system Accessibility prompt; it returns with
      // the current (usually still false) trust state while the user decides,
      // which is why the renderer polls afterwards.
      if (process.env.NADABODHA_DICTATION_NO_ACCESSIBILITY !== '1') {
        try {
          systemPreferences.isTrustedAccessibilityClient(true);
        } catch { /* ignore */ }
        try {
          if (process.platform === 'darwin') {
            await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
          }
        } catch { /* ignore */ }
      }
      applyDictationSetting();
      return dictationStatus();
    }
  );

  // ---- Recorder failure forwarding -----------------------------------------

  // Forward recorder failures (e.g. ffmpeg missing or crashing) to the
  // renderer. Without a listener, EventEmitter rethrows 'error' and Node
  // reports an uncaught exception that takes the main process down (F5).
  recorder.on('error', (err: Error) => {
    emit({ status: 'error', error: err.message });
  });

  // D3: a failed system-audio (catap) spawn degrades meeting capture to
  // mic-only. It is NOT a recorder failure: the mic keeps recording, so the
  // event must not tear down the recording UI — the renderer shows it in
  // the status bar while the pill stays up.
  recorder.on('meeting-error', (message: string) => {
    emit({ status: 'recording', meetingError: message });
  });

  // Start (or deliberately skip) the global Option hook now that every
  // dependency exists.
  applyDictationSetting();

  // Automatic audio retention cleanup on startup if configured
  const startupSettings = settingsStore.get();
  if (startupSettings.audioRetentionDays && startupSettings.audioRetentionDays > 0) {
    try {
      const cleaned = noteStore.deleteOldAudioRecordings(startupSettings.audioRetentionDays);
      if (cleaned.deletedCount > 0) {
        console.log(`[AudioRetention] Startup cleaned up ${cleaned.deletedCount} recording(s) (${(cleaned.freedBytes / (1024 * 1024)).toFixed(1)} MB freed)`);
      }
    } catch (err) {
      console.error('[AudioRetention] Startup cleanup error:', err);
    }
  }

  // ---- Note store (Stage 1) ------------------------------------------------

  ipcMain.handle(IpcChannel.ListNotes, async (): Promise<NoteListResult> => {
    const notes = noteStore.list().map(toNoteInfo);
    return {
      notes,
      folders: noteStore.folders(),
      folderCounts: noteStore.folderCounts(),
    };
  });

  ipcMain.handle(IpcChannel.GetNote, async (_event: unknown, id: string): Promise<NoteGetResult> => {
    const record = noteStore.get(id);
    if (!record) {
      return { error: `Note not found: ${id}` };
    }
    const content = noteStore.readContent(id);
    return {
      note: toNoteInfo(record),
      content: content.data,
      error: content.error,
    };
  });

  ipcMain.handle(
    IpcChannel.CreateNote,
    async (_event: unknown, req: NoteCreateRequest): Promise<NoteActionResult> => {
      if (!req || typeof req !== 'object') {
        return { success: false, error: 'Invalid request' };
      }
      const source = req.source || 'unknown';
      // Stage 1 of the plan ("audio (when recorded)"): a note born from a
      // transcription run keeps a copy of the WAV it was transcribed from.
      // Without this the audio dies in os.tmpdir() and re-transcribe has
      // no bytes to read.
      const audioPath =
        (typeof req.audioPath === 'string' && req.audioPath) ||
        (source === 'recording' || source === 'dictation-log'
          ? transcriptionService.getCurrentFilePath() ?? undefined
          : undefined);
      const result = noteStore.create({
        title: typeof req.title === 'string' ? req.title : undefined,
        source,
        folder: typeof req.folder === 'string' ? req.folder : undefined,
        tags: Array.isArray(req.tags) ? req.tags : undefined,
        transcript: typeof req.transcript === 'string' ? req.transcript : undefined,
        words: req.words,
        // Note field 'model' (plan): which STT model produced this transcript.
        model: settingsStore.get().activeModel || undefined,
        audioPath,
      });
      return {
        success: result.success,
        note: result.data ? toNoteInfo(result.data) : undefined,
        error: result.error,
      };
    }
  );

  ipcMain.handle(
    IpcChannel.UpdateNote,
    async (_event: unknown, req: NoteUpdateRequest): Promise<NoteActionResult> => {
      if (!req || typeof req !== 'object' || !req.id) {
        return { success: false, error: 'Invalid request' };
      }
      const result = noteStore.update(req.id, {
        title: req.title,
        folder: req.folder,
        tags: Array.isArray(req.tags) ? req.tags : undefined,
        transcript: req.transcript,
        summary: req.summary,
        model: req.model,
        audioPath: typeof req.audioPath === 'string' ? req.audioPath : undefined,
        markSummaryStale: req.markSummaryStale,
        clearSummaryStale: req.clearSummaryStale,
        words: req.words,
      });
      return {
        success: result.success,
        note: result.data ? toNoteInfo(result.data) : undefined,
        error: result.error,
      };
    }
  );

  ipcMain.handle(IpcChannel.DeleteNote, async (_event: unknown, id: string): Promise<NoteActionResult> => {
    const result = noteStore.delete(id);
    return { success: result.success, error: result.error };
  });

  ipcMain.handle(IpcChannel.ReadNoteContent, async (_event: unknown, id: string): Promise<NoteGetResult> => {
    const record = noteStore.get(id);
    if (!record) {
      return { error: `Note not found: ${id}` };
    }
    const content = noteStore.readContent(id);
    return { note: toNoteInfo(record), content: content.data, error: content.error };
  });

  ipcMain.handle(IpcChannel.CreateFolder, async (_event: unknown, name: string): Promise<{ success: boolean; data?: string; error?: string }> => {
    return noteStore.createFolder(typeof name === 'string' ? name : '');
  });

  ipcMain.handle(IpcChannel.DeleteFolder, async (_event: unknown, name: string): Promise<{ success: boolean; error?: string }> => {
    return noteStore.deleteFolder(typeof name === 'string' ? name : '');
  });

  ipcMain.handle(IpcChannel.ListFolders, async (): Promise<{ folders: string[]; counts: Record<string, number> }> => {
    return { folders: noteStore.folders(), counts: noteStore.folderCounts() };
  });

  ipcMain.handle(IpcChannel.SearchNotes, async (_event: unknown, query: string): Promise<NoteListResult> => {
    const notes = noteStore.search(typeof query === 'string' ? query : '').map(toNoteInfo);
    return { notes, folders: noteStore.folders(), folderCounts: noteStore.folderCounts() };
  });

  ipcMain.handle(
    IpcChannel.CleanOldAudio,
    async (_event: unknown, days?: number): Promise<CleanOldAudioResult> => {
      const settings = settingsStore.get();
      const retentionDays =
        typeof days === 'number' && Number.isFinite(days)
          ? days
          : settings.audioRetentionDays ?? 90;
      if (retentionDays <= 0) {
        return { success: true, deletedCount: 0, freedBytes: 0 };
      }
      try {
        const result = noteStore.deleteOldAudioRecordings(retentionDays);
        return { success: true, deletedCount: result.deletedCount, freedBytes: result.freedBytes };
      } catch (err) {
        return { success: false, deletedCount: 0, freedBytes: 0, error: describeError(err) };
      }
    }
  );

  ipcMain.handle(
    IpcChannel.ReTranscribe,
    async (_event: unknown, req: ReTranscribeRequest): Promise<ReTranscribeResult> => {
      if (!req || typeof req.noteId !== 'string') {
        return { started: false, error: 'noteId is required' };
      }
      // D4: never run two re-transcribes (or a re-transcribe over any other
      // transcription/recording) concurrently — a second request while one
      // is in flight is rejected, so completion routing keyed to the run's
      // note can never cross notes even if the renderer's slot is stale.
      const state = transcriptionService.getState();
      if (
        reTranscribeRun ||
        state === 'transcribing' ||
        state === 'recording' ||
        recorder.getState().status === 'recording'
      ) {
        return {
          started: false,
          error: 'A transcription is already in progress — wait for it to finish before re-transcribing',
        };
      }
      const record = noteStore.get(req.noteId);
      if (!record) {
        return { started: false, error: `Note not found: ${req.noteId}` };
      }
      if (!record.audio) {
        return { started: false, error: 'This note has no audio — re-transcribe is not available' };
      }
      if (!fs.existsSync(record.audio)) {
        return { started: false, error: `Audio file missing: ${record.audio}` };
      }
      // Re-transcribe uses the same pipeline; the run token stamped onto its
      // events (stampReTranscribe) is what routes the completion back to
      // THIS note. Replace-on-success only: on failure/cancel the renderer
      // never receives a completed event, so the previous transcript stays
      // byte-identical.
      const runId = ++reTranscribeRunSeq;
      reTranscribeRun = { noteId: req.noteId, runId };
      try {
        transcriptionService.startTranscription(record.audio, { origin: 'transcription' });
      } catch (err) {
        reTranscribeRun = null;
        return { started: false, error: describeError(err) };
      }
      return { started: true, runId };
    }
  );

  return { dictation, applyRecordingShortcut };
}


export function showSaveTranscriptDialog(mainWindow: BrowserWindow): string | undefined {
  const result = dialog.showSaveDialogSync(mainWindow, {
    defaultPath: path.join(app.getPath('documents'), 'transcript.txt'),
    filters: [{ name: 'Plain Text', extensions: ['txt'] }],
    properties: ['createDirectory'],
  });
  return result;
}
