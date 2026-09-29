import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import { EventEmitter } from 'events';
import { TranscriptionEvent, TranscriptionStatus } from '../shared/ipc';

export interface TranscriptionAdapterOptions {
  pythonExecutable?: string;
  pythonScriptPath?: string;
  onEvent: (event: TranscriptionEvent) => void;
  onError: (error: Error) => void;
  onExit: (code: number | null) => void;
}

/**
 * Manages the Python subprocess that performs local transcription.
 * Communicates over JSON lines on stdout.
 */
export class TranscriptionAdapter extends EventEmitter {
  private process: ChildProcess | null = null;
  private readonly options: TranscriptionAdapterOptions;
  private buffer = '';

  constructor(options: TranscriptionAdapterOptions) {
    super();
    this.options = options;
  }

  start(): void {
    if (this.process) {
      throw new Error('Transcription adapter already running');
    }

    const python = this.options.pythonExecutable || 'python3';
    const script =
      this.options.pythonScriptPath ||
      path.join(__dirname, '../../python/nadabodha_transcribe.py');

    this.process = spawn(python, [script, '--server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      this.flushLines();
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) {
        this.emit('stderr', line);
      }
    });

    this.process.on('error', (err) => {
      this.options.onError(err);
    });

    this.process.on('exit', (code) => {
      this.process = null;
      this.options.onExit(code);
    });
  }

  startStream(repoId: string, cacheDir: string): NodeJS.WritableStream {
    if (this.process) {
      throw new Error('Transcription adapter already running');
    }

    const python = this.options.pythonExecutable || 'python3';
    const script =
      this.options.pythonScriptPath ||
      path.join(__dirname, '../../python/nadabodha_transcribe.py');

    this.process = spawn(python, [script, '--stream', '--repo_id', repoId, '--cache_dir', cacheDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      this.flushLines();
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) {
        this.emit('stderr', line);
      }
    });

    this.process.on('error', (err) => {
      this.options.onError(err);
    });

    this.process.on('exit', (code) => {
      this.process = null;
      this.options.onExit(code);
    });

    return this.process.stdin!;
  }

  stop(): void {
    if (!this.process) return;
    this.process.kill('SIGTERM');
  }

  send(command: unknown): void {
    if (!this.process || !this.process.stdin) {
      throw new Error('Transcription adapter not running');
    }
    const line = JSON.stringify(command) + '\n';
    this.process.stdin.write(line);
  }

  private flushLines(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    try {
      const parsed = JSON.parse(line);
      const event: TranscriptionEvent = {
        status: parsed.status as TranscriptionStatus,
        text: parsed.text,
        progress: typeof parsed.progress === 'number' ? parsed.progress : undefined,
        error: parsed.error,
        origin: parsed.origin,
        repoId: parsed.repo_id,
        path: parsed.path,
        file: parsed.file,
        bytesDone: typeof parsed.bytes_done === 'number' ? parsed.bytes_done : undefined,
        bytesTotal: typeof parsed.bytes_total === 'number' ? parsed.bytes_total : undefined,
      };
      this.options.onEvent(event);
    } catch (err) {
      this.emit('stderr', `Failed to parse adapter output: ${line}`);
    }
  }
}
