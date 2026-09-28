import { TranscriptionEvent } from '../shared/ipc';
import { CANCEL_KILL_TIMEOUT_MS, ModelDownloadService } from './modelDownloadService';

/**
 * The adapter is replaced by an in-memory double so we can drive its
 * callbacks (events, errors, exits) directly.
 */
jest.mock('./transcriptionAdapter', () => {
  class FakeAdapter {
    static instances: FakeAdapter[] = [];
    options: {
      onEvent: (event: TranscriptionEvent) => void;
      onError: (error: Error) => void;
      onExit: (code: number | null) => void;
    };
    started = false;
    stopped = false;
    sent: Array<Record<string, unknown>> = [];

    constructor(options: FakeAdapter['options']) {
      this.options = options;
      FakeAdapter.instances.push(this);
    }

    start(): void {
      this.started = true;
    }

    stop(): void {
      this.stopped = true;
    }

    send(command: unknown): void {
      this.sent.push(command as Record<string, unknown>);
    }
  }
  return { TranscriptionAdapter: FakeAdapter };
});

interface FakeAdapter {
  options: {
    onEvent: (event: TranscriptionEvent) => void;
    onError: (error: Error) => void;
    onExit: (code: number | null) => void;
  };
  started: boolean;
  stopped: boolean;
  sent: Array<Record<string, unknown>>;
}

function adapters(): FakeAdapter[] {
  const mocked = jest.requireMock('./transcriptionAdapter') as {
    TranscriptionAdapter: { instances: FakeAdapter[] };
  };
  return mocked.TranscriptionAdapter.instances;
}

function lastAdapter(): FakeAdapter {
  const list = adapters();
  return list[list.length - 1];
}

describe('ModelDownloadService', () => {
  let events: TranscriptionEvent[];
  let service: ModelDownloadService;

  beforeEach(() => {
    adapters().length = 0;
    events = [];
    service = new ModelDownloadService({ onEvent: (event) => events.push(event) });
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function start(): FakeAdapter {
    const result = service.start('Systran/faster-whisper-base', '/cache');
    expect(result.started).toBe(true);
    return lastAdapter();
  }

  function terminals(): TranscriptionEvent[] {
    return events.filter((event) =>
      ['completed', 'error', 'cancelled'].includes(event.status)
    );
  }

  it('starts the adapter with the download command', () => {
    const adapter = start();
    expect(adapter.started).toBe(true);
    expect(adapter.sent[0]).toEqual({
      action: 'download_model',
      repo_id: 'Systran/faster-whisper-base',
      cache_dir: '/cache',
    });
    expect(service.isRunning()).toBe(true);
  });

  it('forwards progress and exactly one terminal event', () => {
    const adapter = start();
    adapter.options.onEvent({ status: 'downloading', progress: 10 });
    adapter.options.onEvent({ status: 'completed', progress: 100 });
    // Late duplicate (and the exit that follows the stop) must be dropped.
    adapter.options.onEvent({ status: 'completed', progress: 100 });
    adapter.options.onExit(null);

    expect(events.map((event) => event.status)).toEqual(['downloading', 'completed']);
    expect(terminals()).toHaveLength(1);
    expect(adapter.stopped).toBe(true);
    expect(service.isRunning()).toBe(false);
    expect(service.activeRepoId()).toBeNull();
  });

  it('reports "cancelled" from the safety kill when the adapter never does', () => {
    const adapter = start();
    expect(service.cancel()).toEqual({ cancelled: true });
    expect(adapter.sent).toContainEqual({ action: 'cancel' });
    expect(terminals()).toHaveLength(0);

    jest.advanceTimersByTime(CANCEL_KILL_TIMEOUT_MS - 1);
    expect(terminals()).toHaveLength(0);

    jest.advanceTimersByTime(1);
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0]).toMatchObject({ status: 'cancelled', origin: 'download' });
    expect(adapter.stopped).toBe(true);
    expect(service.isRunning()).toBe(false);
  });

  it('does not double-report when the adapter cancels before the kill fires', () => {
    const adapter = start();
    service.cancel();
    adapter.options.onEvent({ status: 'cancelled' });

    jest.advanceTimersByTime(CANCEL_KILL_TIMEOUT_MS * 2);

    expect(terminals()).toHaveLength(1);
    expect(terminals()[0].status).toBe('cancelled');
  });

  it('reports an error when the process exits without a terminal event', () => {
    const adapter = start();
    adapter.options.onExit(1);

    expect(terminals()).toHaveLength(1);
    expect(terminals()[0]).toMatchObject({ status: 'error', origin: 'download' });
    expect(terminals()[0].error).toContain('exited with code 1');
    expect(service.isRunning()).toBe(false);
  });

  it('reports a cancel when the process is killed before reporting', () => {
    const adapter = start();
    service.cancel();
    adapter.options.onExit(null);

    expect(terminals()).toHaveLength(1);
    expect(terminals()[0].status).toBe('cancelled');
  });

  it('reports an adapter startup failure as a terminal error', () => {
    const adapter = start();
    adapter.options.onError(new Error('spawn ENOENT'));

    expect(terminals()).toHaveLength(1);
    expect(terminals()[0]).toMatchObject({ status: 'error' });
    expect(terminals()[0].error).toContain('spawn ENOENT');
  });

  it('ignores callbacks from a previous download run', () => {
    const first = start();
    service.cancel();
    jest.advanceTimersByTime(CANCEL_KILL_TIMEOUT_MS);
    expect(terminals()).toHaveLength(1);

    events = [];
    const second = start();
    // The stale adapter reports late; it must not touch the new download.
    first.options.onEvent({ status: 'error', error: 'stale failure' });
    first.options.onExit(1);
    first.options.onError(new Error('stale error'));

    expect(events).toHaveLength(0);
    expect(service.isRunning()).toBe(true);
    expect(service.activeRepoId()).toBe('Systran/faster-whisper-base');
    expect(second.started).toBe(true);
  });

  it('refuses a second concurrent download', () => {
    start();
    expect(service.start('openai/whisper-tiny', '/cache')).toEqual({
      started: false,
      error: 'A model download is already running',
    });
  });
});
