import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import { EventEmitter } from 'events';
import { TranscriptionEvent, TranscriptionStatus } from '../shared/ipc';

export interface TranscriptionAdapterOptions {
  pythonExecutable?: string;
  pythonScriptPath?: string;
  onEvent: (event: TranscriptionEvent) => void;
  onError: (error: Error) => void;
  /**
   * The child exited. `code` is null when the process was terminated by a
   * signal — `signal` carries which one so callers can report a real reason
   * instead of "exited with code null".
   */
  onExit: (code: number | null, signal?: NodeJS.Signals | null) => void;
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

    this.process.on('exit', (code, signal) => {
      this.process = null;
      this.options.onExit(code, signal);
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

    this.process.on('exit', (code, signal) => {
      this.process = null;
      this.options.onExit(code, signal);
    });

    return this.process.stdin!;
  }

  stop(): void {
    const proc = this.process;
    if (!proc) return;
    // A child that never spawned (ENOENT python) has no pid; killing it would
    // signal pid 0 — the whole process group. Same guard the recorder uses.
    if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) {
      return;
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      // Best-effort: the child may have exited between the check and the kill.
    }
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
        // Streaming partials and word timestamps are part of the adapter's
        // JSON contract; dropping them here silently broke live partials.
        partial: typeof parsed.partial === 'boolean' ? parsed.partial : undefined,
        words: Array.isArray(parsed.words) ? parsed.words : undefined,
      };
      this.options.onEvent(event);
    } catch {
      this.emit('stderr', `Failed to parse adapter output: ${line}`);
    }
  }
}
