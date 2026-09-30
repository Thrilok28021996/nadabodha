/**
 * Integration tests for the dictation wiring inside setupIpcHandlers — the
 * layer the review findings name: the status IPC the renderer polls after an
 * Accessibility grant (BLOCKING-1) and the recorder cancel that has to run
 * when the hook goes away with a take open (MEDIUM-1 / MEDIUM-2).
 *
 * Electron and uiohook-napi are mocked; the real DictationController, the
 * real take bookkeeping and the real status/abort paths all run.
 */
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp') },
  BrowserWindow: jest.fn(),
  dialog: { showOpenDialog: jest.fn(), showSaveDialogSync: jest.fn() },
  ipcMain: { handle: jest.fn() },
  clipboard: { writeText: jest.fn() },
  systemPreferences: {
    isTrustedAccessibilityClient: jest.fn(),
    getMediaAccessStatus: jest.fn(),
    askForMediaAccess: jest.fn(),
  },
}));

jest.mock('uiohook-napi', () => {
  const { EventEmitter } = jest.requireActual('events') as typeof import('events');
  const hook = new EventEmitter() as EventEmitter & { start: jest.Mock; stop: jest.Mock };
  hook.start = jest.fn();
  hook.stop = jest.fn();
  return { uIOhook: hook };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { BrowserWindow, ipcMain, systemPreferences } from 'electron';
import { EventEmitter } from 'events';
import { uIOhook } from 'uiohook-napi';
import { AudioRecorder } from './audioRecorder';
import { setupIpcHandlers } from './ipcHandlers';
import { SettingsStore } from './settingsStore';
import { TranscriptionService } from './transcriptionService';
import { DictationStatusInfo, IpcChannel } from '../shared/ipc';
import { NoteStore } from './noteStore';

type Handler = (...args: unknown[]) => unknown;
type MockHook = EventEmitter & { start: jest.Mock; stop: jest.Mock };

const hook = uIOhook as unknown as MockHook;
const sp = systemPreferences as unknown as {
  isTrustedAccessibilityClient: jest.Mock;
  getMediaAccessStatus: jest.Mock;
  askForMediaAccess: jest.Mock;
};

const handlers = new Map<string, Handler>();
const sentEvents: Array<Record<string, unknown>> = [];
let recorderStatus: 'idle' | 'recording' | 'error' = 'idle';
let settings: Record<string, unknown> = {};

const recorder = {
  on: jest.fn(),
  getState: () => ({ status: recorderStatus, outputPath: null }),
  start: jest.fn(() => {
    recorderStatus = 'recording';
    return '/tmp/nadabodha-test/recording.wav';
  }),
  stop: jest.fn(async () => {
    recorderStatus = 'idle';
    return null;
  }),
  cancel: jest.fn(() => {
    recorderStatus = 'idle';
    return null;
  }),
};

const transcriptionService = {
  onEvent: jest.fn(),
  getState: () => 'idle',
  getTranscript: () => '',
  getCurrentFilePath: () => null,
  startTranscription: jest.fn(),
  cancel: jest.fn(),
};

const settingsStore = {
  get: () => settings,
  update: (patch: Record<string, unknown>) => {
    settings = { ...settings, ...patch };
    return settings;
  },
};

const mockNoteStore = {
  list: jest.fn(() => []),
  get: jest.fn(),
  folders: jest.fn(() => []),
  folderCounts: jest.fn(() => ({})),
  search: jest.fn(() => []),
  readContent: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  reindex: jest.fn(() => ({ success: true })),
  setDataDir: jest.fn(() => ({ success: true })),
  migrateFromLegacy: jest.fn(),
};

const mainWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, payload: Record<string, unknown>) => {
      sentEvents.push(payload);
      void channel;
    },
  },
};

/** OPTION keydown, the same event shape the real hook delivers. */
const OPTION_DOWN = { type: 4, keycode: 0x38 };

function setup(trusted: boolean): ReturnType<typeof setupIpcHandlers> {
  sp.isTrustedAccessibilityClient.mockReturnValue(trusted);
  sp.getMediaAccessStatus.mockReturnValue('granted');
  return setupIpcHandlers({
    mainWindow: mainWindow as unknown as BrowserWindow,
    transcriptionService: transcriptionService as unknown as TranscriptionService,
    recorder: recorder as unknown as AudioRecorder,
    settingsStore: settingsStore as unknown as SettingsStore,
    noteStore: mockNoteStore as unknown as NoteStore,
  });
}

function handlerFor(channel: IpcChannel): Handler {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`no ipc handler registered for ${channel}`);
  }
  return handler;
}

async function readStatus(): Promise<DictationStatusInfo> {
  return (await handlerFor(IpcChannel.DictationStatus)()) as DictationStatusInfo;
}

/** Let the async permission check inside startDictationTake settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Open a dictation take the same way a real Option hold does. */
async function openTake(): Promise<void> {
  hook.emit('keydown', OPTION_DOWN);
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  handlers.clear();
  sentEvents.length = 0;
  recorderStatus = 'idle';
  settings = { dictationEnabled: true };
  // Every test builds a fresh controller against this shared hook instance.
  hook.removeAllListeners();
  (ipcMain.handle as jest.Mock).mockImplementation((channel: string, handler: Handler) => {
    handlers.set(channel, handler);
  });
});

describe('Accessibility grant -> guarded start (BLOCKING-1)', () => {
  it('starts the hook on the first status read after an async grant', async () => {
    const { dictation } = setup(false);

    const before = await readStatus();
    expect(before.accessibilityTrusted).toBe(false);
    expect(before.running).toBe(false);
    expect(hook.start).not.toHaveBeenCalled();
    expect(dictation?.isRunning()).toBe(false);

    // The user clicks Allow on the system prompt; the renderer's polling loop
    // simply reads the status again — that read is the start path.
    sp.isTrustedAccessibilityClient.mockReturnValue(true);

    const after = await readStatus();
    expect(after.accessibilityTrusted).toBe(true);
    expect(after.running).toBe(true);
    expect(hook.start).toHaveBeenCalledTimes(1);
    expect(dictation?.isRunning()).toBe(true);

    // The guard is the mock call immediately before hook.start(), and it never
    // prompts (ask === false) on this path either.
    const trustChecks = sp.isTrustedAccessibilityClient.mock.invocationCallOrder;
    const startOrder = hook.start.mock.invocationCallOrder[0];
    expect(trustChecks).toContain(startOrder - 1);
    expect(sp.isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
    expect(sp.isTrustedAccessibilityClient).not.toHaveBeenCalledWith(true);
  });

  it('keeps the hook stopped on every read while trust stays false', async () => {
    setup(false);
    await readStatus();
    await readStatus();

    const status = await readStatus();
    expect(status.accessibilityTrusted).toBe(false);
    expect(status.running).toBe(false);
    expect(hook.start).not.toHaveBeenCalled();
    expect(sp.isTrustedAccessibilityClient).not.toHaveBeenCalledWith(true);
  });

  it('does not touch a hook that is already running when trust is re-read', async () => {
    setup(true);
    expect(hook.start).toHaveBeenCalledTimes(1);
    await readStatus();
    await readStatus();
    expect((await readStatus()).running).toBe(true);
    expect(hook.start).toHaveBeenCalledTimes(1);
  });
});

describe('hook stopping with a take open (MEDIUM-1)', () => {
  it('cancels the active recorder when dictationEnabled is switched off mid-take', async () => {
    setup(true);
    await openTake();
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(recorderStatus).toBe('recording');

    await handlerFor(IpcChannel.SettingsSet)({}, { dictationEnabled: false });

    expect(recorder.cancel).toHaveBeenCalledTimes(1);
    expect(recorderStatus).toBe('idle');
    expect(hook.stop).toHaveBeenCalledTimes(1);
    // The aborted take must never reach the transcription pipeline.
    expect(transcriptionService.startTranscription).not.toHaveBeenCalled();

    const status = await readStatus();
    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
  });

  it('cancels the active recorder when the app stops the hook on quit', async () => {
    const { dictation } = setup(true);
    await openTake();
    expect(recorder.start).toHaveBeenCalledTimes(1);

    // Exactly what the will-quit handler in main.ts runs.
    dictation?.stop();

    expect(recorder.cancel).toHaveBeenCalledTimes(1);
    expect(recorderStatus).toBe('idle');
    expect(hook.stop).toHaveBeenCalledTimes(1);
    expect(transcriptionService.startTranscription).not.toHaveBeenCalled();
    expect(dictation?.isRunning()).toBe(false);
  });

  it('does not cancel the recorder when the hook stops with no take open', async () => {
    const { dictation } = setup(true);
    dictation?.stop();
    expect(recorder.cancel).not.toHaveBeenCalled();
    expect(recorder.start).not.toHaveBeenCalled();
  });
});

describe('hook failure with a take open (MEDIUM-2)', () => {
  it('cancels the recorder and reports the hook as failed', async () => {
    const { dictation } = setup(true);
    await openTake();
    expect(recorder.start).toHaveBeenCalledTimes(1);

    hook.emit('error', new Error('event tap died'));

    expect(recorder.cancel).toHaveBeenCalledTimes(1);
    expect(recorderStatus).toBe('idle');
    expect(transcriptionService.startTranscription).not.toHaveBeenCalled();
    expect(dictation?.isRunning()).toBe(false);

    const status = await readStatus();
    expect(status.running).toBe(false);
    expect(status.reason).toBe('hook-error');
    // A status read must not silently restart a hook that just failed.
    expect(hook.start).toHaveBeenCalledTimes(1);
  });

  it('cancels the recorder when the hook reports that it stopped', async () => {
    const { dictation } = setup(true);
    await openTake();
    expect(recorder.start).toHaveBeenCalledTimes(1);

    hook.emit('stop');

    expect(recorder.cancel).toHaveBeenCalledTimes(1);
    expect(recorderStatus).toBe('idle');
    expect(transcriptionService.startTranscription).not.toHaveBeenCalled();
    expect(dictation?.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D4 — re-transcribe concurrency and completion routing
// ---------------------------------------------------------------------------

describe('Re-transcribe run token (D4)', () => {
  let audioDir = '';
  let audioA = '';
  let audioB = '';

  type Listener = (event: Record<string, unknown>) => Promise<void> | void;

  function runListener(): Listener {
    const calls = transcriptionService.onEvent.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][0] as Listener;
  }

  function reTranscribe(noteId: string): Promise<{ started: boolean; error?: string; runId?: number }> {
    return handlerFor(IpcChannel.ReTranscribe)({}, { noteId }) as Promise<{
      started: boolean;
      error?: string;
      runId?: number;
    }>;
  }

  beforeEach(() => {
    audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadabodha-d4-'));
    audioA = path.join(audioDir, 'note-a.wav');
    audioB = path.join(audioDir, 'note-b.wav');
    fs.writeFileSync(audioA, 'RIFFfake-a');
    fs.writeFileSync(audioB, 'RIFFfake-b');
    // The shared settings mock is minimal; the completed-event listener
    // reads llm fields unconditionally (prod settings always have them).
    settings = {
      dictationEnabled: true,
      summarizationEnabled: false,
      autoSummarize: false,
      llmBaseUrl: '',
      llmModel: '',
      dataDir: '',
    };
    mockNoteStore.get.mockImplementation((id: string) => ({
      id,
      title: `note ${id}`,
      created: new Date('2026-01-01T00:00:00Z'),
      source: 'recording',
      folder: '',
      duration: 1,
      model: 'model-x',
      audio: id === 'noteA' ? audioA : audioB,
      summaryStale: false,
    }));
  });

  afterEach(() => {
    if (audioDir) fs.rmSync(audioDir, { recursive: true, force: true });
  });

  it('rejects a second re-transcribe while one is in flight; routing never crosses', async () => {
    setup(true);
    const listener = runListener();

    const first = await reTranscribe('noteA');
    expect(first.started).toBe(true);
    expect(first.runId).toBe(1);
    expect(transcriptionService.startTranscription).toHaveBeenCalledTimes(1);
    expect(transcriptionService.startTranscription).toHaveBeenCalledWith(audioA, {
      origin: 'transcription',
    });

    // A is in flight: B must be rejected, never queued behind A's back.
    const second = await reTranscribe('noteB');
    expect(second.started).toBe(false);
    expect(second.error).toMatch(/already in progress/i);
    expect(transcriptionService.startTranscription).toHaveBeenCalledTimes(1);

    // A's completion still carries A's token — the slot cannot cross to B.
    await listener({ status: 'completed', text: 'transcript for A' });
    const completed = sentEvents.find((e) => e.status === 'completed');
    expect(completed).toBeDefined();
    expect(completed?.reTranscribeNoteId).toBe('noteA');
    expect(completed?.reTranscribeRunId).toBe(1);
    expect(completed?.text).toBe('transcript for A');
    // Routing happens in the renderer via the token; main never rewrites
    // the note itself.
    expect(mockNoteStore.update).not.toHaveBeenCalled();
  });

  it('routes the completion to the originating note and frees the run after', async () => {
    setup(true);
    const listener = runListener();

    const started = await reTranscribe('noteA');
    expect(started.started).toBe(true);

    await listener({ status: 'transcribing', progress: 50 });
    await listener({ status: 'completed', text: 'fresh words', origin: 'transcription' });

    const completed = sentEvents.find((e) => e.status === 'completed');
    expect(completed?.reTranscribeNoteId).toBe('noteA');
    expect(completed?.reTranscribeRunId).toBe(started.runId);

    // Terminal event cleared the run: a later re-transcribe starts with a
    // new token instead of being locked out forever.
    const again = await reTranscribe('noteB');
    expect(again.started).toBe(true);
    expect(again.runId).toBe(2);
    expect(transcriptionService.startTranscription).toHaveBeenLastCalledWith(audioB, {
      origin: 'transcription',
    });
  });

  it('failure path never writes the note — the old transcript stays byte-identical', async () => {
    setup(true);
    const listener = runListener();

    const started = await reTranscribe('noteA');
    expect(started.started).toBe(true);

    // Adapter dies mid-run: the renderer gets a stamped error, never a
    // completed event, and no note write happens anywhere in main.
    await listener({ status: 'error', error: 'adapter died', origin: 'transcription' });

    const errored = sentEvents.find((e) => e.status === 'error');
    expect(errored?.error).toBe('adapter died');
    expect(errored?.reTranscribeNoteId).toBe('noteA');
    expect(sentEvents.some((e) => e.status === 'completed')).toBe(false);
    expect(mockNoteStore.update).not.toHaveBeenCalled();
    expect(mockNoteStore.create).not.toHaveBeenCalled();

    // The run is over: the next request is allowed (no permanent lock).
    const again = await reTranscribe('noteB');
    expect(again.started).toBe(true);
    expect(again.runId).toBe(2);
  });

  it('converts a throwing startTranscribe into started:false and frees the run', async () => {
    setup(true);
    transcriptionService.startTranscription.mockImplementationOnce(() => {
      throw new Error('Cannot start transcription while in state transcribing');
    });

    const result = await reTranscribe('noteA');
    expect(result.started).toBe(false);
    expect(result.error).toContain('Cannot start transcription');

    // The failed attempt must not leave a phantom run behind: the next
    // request starts and receives a fresh, distinct token.
    const second = await reTranscribe('noteA');
    expect(second.started).toBe(true);
    expect(typeof second.runId).toBe('number');
    expect(transcriptionService.startTranscription).toHaveBeenCalledTimes(2);
  });
});
