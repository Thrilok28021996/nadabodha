import fs from 'fs';
import { TranscriptionAdapter } from './transcriptionAdapter';
import {
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

export interface TranscriptionServiceOptions {
  pythonExecutable?: string;
  pythonScriptPath?: string;
}

export class TranscriptionService {
  private adapter: TranscriptionAdapter | null = null;
  private state: ServiceState = 'idle';
  private currentFilePath: string | null = null;
  private transcript = '';
  private lastError?: string;
  private listeners: ((event: TranscriptionEvent) => void)[] = [];

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

  startTranscription(filePath: string): void {
    if (this.state === 'recording' || this.state === 'transcribing') {
      throw new Error(`Cannot start transcription while in state ${this.state}`);
    }

    if (!fs.existsSync(filePath)) {
      this.setState('error', undefined, `File not found: ${filePath}`);
      return;
    }

    this.currentFilePath = filePath;
    this.transcript = '';
    this.lastError = undefined;
    this.setState('transcribing', 0);

    this.adapter = new TranscriptionAdapter({
      pythonExecutable: this.options.pythonExecutable,
      pythonScriptPath: this.options.pythonScriptPath,
      onEvent: (event) => this.handleAdapterEvent(event),
      onError: (err) => {
        this.setState('error', undefined, err.message);
      },
      onExit: (code) => {
        if (this.state === 'transcribing' && code !== 0) {
          this.setState(
            'error',
            undefined,
            `Transcription process exited with code ${code}`
          );
        }
      },
    });

    this.adapter.start();
    this.adapter.send({ action: 'transcribe', file_path: filePath });
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
    this.broadcast({ status: 'idle' });
  }

  private handleAdapterEvent(event: TranscriptionEvent): void {
    if (event.status === 'transcribing') {
      this.setState('transcribing', event.progress);
    } else if (event.status === 'completed') {
      this.transcript = event.text || '';
      this.setState('completed', 100, undefined, this.transcript);
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
    text?: string
  ): void {
    this.state = state;
    if (error !== undefined) this.lastError = error;
    this.broadcast({
      status: state as TranscriptionStatus,
      progress,
      error,
      text,
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
  }
}
