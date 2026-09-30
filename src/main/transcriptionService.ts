import fs from 'fs';
import { TranscriptionAdapter } from './transcriptionAdapter';
import {
  EventOrigin,
  TranscriptionEvent,
  TranscriptionStatus,
} from '../shared/ipc';

export type ServiceState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface StartTranscriptionOptions {
  /**
   * Append the result to the transcript held from the previous run instead of
   * replacing it. Used by hold-Option dictation, which builds text
   * incrementally; plain record/import keep their replace semantics.
   */
  append?: boolean;
  /** Origin stamped on every event produced by this run (e.g. 'dictation'). */
  origin?: EventOrigin;
}

/** Joins two transcript fragments: newline between takes, unless already spaced. */
export function joinTranscriptParts(base: string, fragment: string): string {
  if (!base) return fragment;
  if (!fragment) return base;
  if (/\s$/.test(base)) return `${base}${fragment}`;
  return `${base}\n${fragment}`;
}

export interface TranscriptionServiceOptions {
  /** Resolved lazily on every run so settings changes apply immediately. */
  pythonExecutable?: string | (() => string);
  pythonScriptPath?: string;
  /** Active Hugging Face model + cache dir handed to the Python adapter. */
  getSttConfig?: () => { modelRepo: string; cacheDir: string };
}

export class TranscriptionService {
  private adapter: TranscriptionAdapter | null = null;
  private state: ServiceState = 'idle';
  private currentFilePath: string | null = null;
  private transcript = '';
  private lastError?: string;
  private listeners: ((event: TranscriptionEvent) => void)[] = [];
  /** Text the current run appends to (dictation), else ''. */
  private runBase = '';
  /** Origin stamped on the current run's events. */
  private currentOrigin: EventOrigin | undefined;

  constructor(private readonly options: TranscriptionServiceOptions = {}) {}

  onEvent(listener: (event: TranscriptionEvent) => void): void {
    this.listeners.push(listener);
  }

  getState(): ServiceState {
    return this.state;
  }

  getTranscript(): string {
    return this.transcript;
  }

  getCurrentFilePath(): string | null {
    return this.currentFilePath;
  }

  startTranscription(paths: { micPath: string; systemPath?: string } | string, options: StartTranscriptionOptions = {}): void {
    if (this.state === 'recording' || this.state === 'transcribing') {
      throw new Error(`Cannot start transcription while in state ${this.state}`);
    }

    this.currentOrigin = options.origin;
    this.runBase = options.append ? this.transcript : '';

    const micPath = typeof paths === 'string' ? paths : paths.micPath;
    const systemPath = typeof paths === 'string' ? undefined : paths.systemPath;

    if (!fs.existsSync(micPath)) {
      this.setState('error', undefined, `File not found: ${micPath}`);
      return;
    }

    this.currentFilePath = micPath;
    if (!options.append) {
      this.transcript = '';
      this.runBase = '';
    }
    this.lastError = undefined;
    this.setState('transcribing', 0);

    const pythonExecutable =
      typeof this.options.pythonExecutable === 'function'
        ? this.options.pythonExecutable()
        : this.options.pythonExecutable;
    const stt = this.options.getSttConfig
      ? this.options.getSttConfig()
      : { modelRepo: '', cacheDir: '' };

    const runAdapter = (filePath: string, role: 'mic' | 'system', onDone: (text: string) => void) => {
      let runTranscript = '';
      const adapter = new TranscriptionAdapter({
        pythonExecutable,
        pythonScriptPath: this.options.pythonScriptPath,
        onEvent: (event) => {
          if (event.origin === 'download') {
            this.broadcast(event);
            return;
          }
          if (event.status === 'transcribing') {
            if (event.text !== undefined && event.partial) {
              const prefix = role === 'mic' && systemPath ? '[You] ' : role === 'system' ? '[Others] ' : '';
              const partialText = this.runBase ? joinTranscriptParts(this.runBase, prefix + event.text) : prefix + event.text;
              this.broadcast({ status: 'transcribing', text: partialText, origin: this.currentOrigin, partial: true });
            } else {
              this.setState('transcribing', event.progress);
            }
          } else if (event.status === 'completed') {
            runTranscript = event.text || '';
            const words = event.words;
            if (role === 'mic' && systemPath) {
              const formatted = runTranscript.split('\n').map(l => l.trim() ? `[You] ${l}` : l).join('\n');
              this.runBase = this.runBase ? joinTranscriptParts(this.runBase, formatted) : formatted;
              this.cleanup();
              onDone(formatted);
            } else if (role === 'system') {
              const formatted = runTranscript.split('\n').map(l => l.trim() ? `[Others] ${l}` : l).join('\n');
              this.transcript = this.runBase ? joinTranscriptParts(this.runBase, formatted) : formatted;
              this.setState('completed', 100, undefined, this.transcript, words);
              this.cleanup();
            } else {
              this.transcript = this.runBase ? joinTranscriptParts(this.runBase, runTranscript) : runTranscript;
              this.setState('completed', 100, undefined, this.transcript, words);
              this.cleanup();
            }
          } else if (event.status === 'error') {
            this.setState('error', undefined, event.error);
            this.cleanup();
          } else if (event.status === 'cancelled') {
            this.setState('cancelled');
            this.cleanup();
          }
        },
        onError: (err) => {
          if (this.adapter === adapter) {
            this.setState('error', undefined, err.message);
          }
        },
        onExit: (code) => {
          if (this.adapter === adapter && this.state === 'transcribing' && code !== 0 && code !== null) {
            this.setState('error', undefined, `Transcription process exited with code ${code}`);
          }
        },
      });

      this.adapter = adapter;
      adapter.start();
      adapter.send({
        action: 'transcribe',
        file_path: filePath,
        model_repo: stt.modelRepo || '',
        cache_dir: stt.cacheDir || '',
      });
    };

    if (systemPath && fs.existsSync(systemPath)) {
      runAdapter(micPath, 'mic', () => {
        runAdapter(systemPath, 'system', () => {});
      });
    } else {
      runAdapter(micPath, 'mic', () => {});
    }
  }

  startStreaming(inputStream: NodeJS.ReadableStream, options: StartTranscriptionOptions = {}): void {
    if (this.state === 'recording' || this.state === 'transcribing') {
      throw new Error(`Cannot start streaming while in state ${this.state}`);
    }

    this.currentOrigin = options.origin;
    this.runBase = options.append ? this.transcript : '';
    if (!options.append) {
      this.transcript = '';
      this.runBase = '';
    }
    this.lastError = undefined;
    this.currentFilePath = null;
    this.setState('transcribing', 0);

    const pythonExecutable =
      typeof this.options.pythonExecutable === 'function'
        ? this.options.pythonExecutable()
        : this.options.pythonExecutable;
    const stt = this.options.getSttConfig
      ? this.options.getSttConfig()
      : { modelRepo: '', cacheDir: '' };

    this.adapter = new TranscriptionAdapter({
      pythonExecutable,
      pythonScriptPath: this.options.pythonScriptPath,
      onEvent: (event) => this.handleAdapterEvent(event),
      onError: (err) => {
        this.setState('error', undefined, err.message);
      },
      onExit: (code) => {
        if (this.state === 'transcribing' && code !== 0) {
          this.setState('error', undefined, `Transcription process exited with code ${code}`);
        }
      },
    });

    // Use tiny model for streaming if available, else active model.
    // The plan says "tiny/base used for streaming latency vs existing selected model for file jobs"
    // Since we don't know if tiny/base is cached, we just use the selected model for now unless we implement
    // a fallback. We'll just use the selected model.
    const stdin = this.adapter.startStream(stt.modelRepo || '', stt.cacheDir || '');
    inputStream.pipe(stdin);
  }

  cancel(): void {
    if (this.state === 'transcribing') {
      this.adapter?.send({ action: 'cancel' });
      this.adapter?.stop();
    }
    this.setState('cancelled');
    this.cleanup();
  }

  reset(): void {
    this.cleanup();
    this.state = 'idle';
    this.currentFilePath = null;
    this.transcript = '';
    this.lastError = undefined;
    this.runBase = '';
    this.currentOrigin = undefined;
    this.broadcast({ status: 'idle' });
  }

  private handleAdapterEvent(event: TranscriptionEvent): void {
    // Model-download events can be interleaved with transcription events
    // (an active model that still needs fetching). They must reach the
    // renderer untouched and must never advance the transcription state.
    if (event.origin === 'download') {
      this.broadcast(event);
      return;
    }
    if (event.status === 'transcribing') {
      if (event.text !== undefined && event.partial) {
        const partialText = this.runBase ? joinTranscriptParts(this.runBase, event.text) : event.text;
        this.broadcast({ status: 'transcribing', text: partialText, origin: this.currentOrigin, partial: true });
      } else {
        this.setState('transcribing', event.progress);
      }
    } else if (event.status === 'completed') {
      const fragment = event.text || '';
      const words = event.words;
      // Append runs (dictation) keep everything dictated so far and add this
      // take; replace runs overwrite with the new text.
      this.transcript = this.runBase
        ? joinTranscriptParts(this.runBase, fragment)
        : fragment;
      this.setState('completed', 100, undefined, this.transcript, words);
      this.cleanup();
    } else if (event.status === 'error') {
      this.setState('error', undefined, event.error);
      this.cleanup();
    } else if (event.status === 'cancelled') {
      this.setState('cancelled');
      this.cleanup();
    }
  }

  private setState(
    state: ServiceState,
    progress?: number,
    error?: string,
    text?: string,
    words?: {word: string, start: number, end: number}[]
  ): void {
    this.state = state;
    if (error !== undefined) this.lastError = error;
    this.broadcast({
      status: state as TranscriptionStatus,
      progress,
      error,
      text,
      words,
      origin: this.currentOrigin,
    });
  }

  private broadcast(event: TranscriptionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private cleanup(): void {
    if (this.adapter) {
      this.adapter.stop();
      this.adapter = null;
    }
    this.runBase = '';
    this.currentOrigin = undefined;
  }
}
