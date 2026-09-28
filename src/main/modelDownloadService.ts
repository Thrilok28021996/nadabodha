import { TranscriptionAdapter } from './transcriptionAdapter';
import { TranscriptionEvent } from '../shared/ipc';

/**
 * Drives the Python adapter's `download_model` action: Hugging Face snapshot
 * download with progress events forwarded on the existing event stream
 * (origin 'download'). Cancellable (a safety kill guarantees the child
 * process never outlives a cancel by more than a few seconds).
 */

export interface ModelDownloadOptions {
  /** Executable or resolver (same precedence as transcription). */
  pythonExecutable?: string | (() => string);
  pythonScriptPath?: string;
  onEvent: (event: TranscriptionEvent) => void;
}

export type DownloadStartResult = { started: boolean; error?: string };

const TERMINAL_STATUSES = new Set(['completed', 'error', 'cancelled']);

export class ModelDownloadService {
  private adapter: TranscriptionAdapter | null = null;
  private repoId: string | null = null;
  private sawTerminal = false;
  private cancelling = false;
  private killTimer: NodeJS.Timeout | null = null;

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

    const adapter = new TranscriptionAdapter({
      pythonExecutable,
      pythonScriptPath: this.options.pythonScriptPath,
      onEvent: (event) => {
        const enriched: TranscriptionEvent = {
          ...event,
          origin: 'download',
          repoId: event.repoId || target,
        };
        this.options.onEvent(enriched);
        if (TERMINAL_STATUSES.has(enriched.status)) {
          this.sawTerminal = true;
          this.finish();
        }
      },
      onError: (err) => {
        if (!this.sawTerminal) {
          this.options.onEvent({
            status: 'error',
            origin: 'download',
            repoId: target,
            error: `Model download failed: ${err.message}`,
          });
        }
        this.finish();
      },
      onExit: (code) => {
        if (!this.sawTerminal && !this.cancelling && code !== 0 && code !== null) {
          this.options.onEvent({
            status: 'error',
            origin: 'download',
            repoId: target,
            error: `Model download process exited with code ${code}`,
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
    // Safety net: if the adapter never reports a terminal event, kill it.
    this.scheduleKill(15000);
    return { cancelled: true };
  }

  private scheduleKill(ms: number): void {
    this.clearKillTimer();
    this.killTimer = setTimeout(() => {
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
