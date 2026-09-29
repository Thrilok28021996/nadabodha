import { TranscriptionAdapter } from './transcriptionAdapter';
import { TranscriptionEvent } from '../shared/ipc';

/**
 * Drives the Python adapter's `download_model` action: Hugging Face snapshot
 * download with progress events forwarded on the existing event stream
 * (origin 'download'). Cancellable (a safety kill guarantees the child
 * process never outlives a cancel by more than a few seconds).
 *
 * Exactly one terminal event (completed / error / cancelled) is forwarded for
 * every download: the adapter normally reports it, and the safety kill reports
 * it when the adapter cannot (a wedged process, a swallowed cancellation).
 */

export interface ModelDownloadOptions {
  /** Executable or resolver (same precedence as transcription). */
  pythonExecutable?: string | (() => string);
  pythonScriptPath?: string;
  onEvent: (event: TranscriptionEvent) => void;
}

export type DownloadStartResult = { started: boolean; error?: string };

const TERMINAL_STATUSES = new Set(['completed', 'error', 'cancelled']);

/** Safety net: a cancel must never leave the UI "Downloading" for longer. */
export const CANCEL_KILL_TIMEOUT_MS = 15000;

export class ModelDownloadService {
  private adapter: TranscriptionAdapter | null = null;
  private repoId: string | null = null;
  private sawTerminal = false;
  private cancelling = false;
  private killTimer: NodeJS.Timeout | null = null;
  /** Identifies the current download; stale callbacks are dropped. */
  private runId = 0;
  private runSeq = 0;

  constructor(private readonly options: ModelDownloadOptions) {}

  isRunning(): boolean {
    return this.adapter !== null;
  }

  activeRepoId(): string | null {
    return this.repoId;
  }

  start(repoId: string, cacheDir: string): DownloadStartResult {
    const target = (repoId || '').trim();
    if (!target) {
      return { started: false, error: 'No model selected' };
    }
    if (this.adapter) {
      return { started: false, error: 'A model download is already running' };
    }

    const pythonExecutable =
      typeof this.options.pythonExecutable === 'function'
        ? this.options.pythonExecutable()
        : this.options.pythonExecutable;

    this.repoId = target;
    this.sawTerminal = false;
    this.cancelling = false;
    const runId = ++this.runSeq;
    this.runId = runId;
    const isCurrent = (): boolean => this.runId === runId;

    const adapter = new TranscriptionAdapter({
      pythonExecutable,
      pythonScriptPath: this.options.pythonScriptPath,
      onEvent: (event) => {
        if (!isCurrent()) return;
        const enriched: TranscriptionEvent = {
          ...event,
          origin: 'download',
          repoId: event.repoId || target,
        };
        if (TERMINAL_STATUSES.has(enriched.status)) {
          this.emitTerminal(enriched);
          this.finish();
          return;
        }
        this.options.onEvent(enriched);
      },
      onError: (err) => {
        if (!isCurrent()) return;
        this.emitTerminal({
          status: 'error',
          origin: 'download',
          repoId: target,
          error: `Model download failed: ${err.message}`,
        });
        this.finish();
      },
      onExit: (code) => {
        if (!isCurrent()) return;
        // The adapter died without a terminal event (killed, crashed, or a
        // cancellation it could not report): surface one so the UI recovers.
        if (this.cancelling) {
          this.emitTerminal({
            status: 'cancelled',
            origin: 'download',
            repoId: target,
          });
        } else if (code !== 0) {
          this.emitTerminal({
            status: 'error',
            origin: 'download',
            repoId: target,
            error: `Model download process exited with code ${code}`,
          });
        } else {
          this.emitTerminal({
            status: 'error',
            origin: 'download',
            repoId: target,
            error: 'Model download process ended before reporting a result',
          });
        }
        this.finish();
      },
    });

    this.adapter = adapter;
    adapter.start();
    adapter.send({
      action: 'download_model',
      repo_id: target,
      cache_dir: (cacheDir || '').trim(),
    });

    return { started: true };
  }

  cancel(): { cancelled: boolean } {
    if (!this.adapter) {
      return { cancelled: false };
    }
    this.cancelling = true;
    try {
      this.adapter.send({ action: 'cancel' });
    } catch {
      // Process already gone; finish below.
    }
    // Safety net: if the adapter never reports a terminal event, emit one
    // here and kill the process.
    this.scheduleKill(CANCEL_KILL_TIMEOUT_MS);
    return { cancelled: true };
  }

  /** Forwards a terminal event exactly once per download. */
  private emitTerminal(event: TranscriptionEvent): void {
    if (this.sawTerminal) {
      return;
    }
    this.sawTerminal = true;
    this.options.onEvent(event);
  }

  private scheduleKill(ms: number): void {
    this.clearKillTimer();
    const repoId = this.repoId;
    const runId = this.runId;
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.runId !== runId) {
        return;
      }
      // The safety kill is itself a terminal transition: without this the
      // failure was silent and the UI stayed on "Downloading" forever.
      if (this.cancelling) {
        this.emitTerminal({
          status: 'cancelled',
          origin: 'download',
          repoId: repoId || undefined,
        });
      } else {
        this.emitTerminal({
          status: 'error',
          origin: 'download',
          repoId: repoId || undefined,
          error: 'Model download did not finish in time and was stopped',
        });
      }
      this.finish();
    }, ms);
  }

  private clearKillTimer(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  private finish(): void {
    this.clearKillTimer();
    const adapter = this.adapter;
    this.adapter = null;
    this.repoId = null;
    if (adapter) {
      adapter.stop();
    }
  }
}
