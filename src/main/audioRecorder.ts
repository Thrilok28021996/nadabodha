import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

export interface AudioRecorderOptions {
  sampleRate?: number;
  channels?: number;
  durationLimitSeconds?: number;
  /**
   * Recording executable. Defaults to `ffmpeg` from PATH; point it at a
   * specific binary to use a custom build or to exercise the missing-binary
   * path without depending on the caller's environment.
   */
  ffmpegPath?: string;
}

interface RecorderState {
  status: 'idle' | 'recording' | 'error';
  error?: string;
  outputPath: string | null;
}

/**
 * Records microphone audio to a WAV file using ffmpeg (or avconv).
 *
 * Falls back to arecord on Linux, but on macOS the default recorder is
 * ffmpeg via the installed executable. The recording is written to a
 * temporary WAV file and the file path is returned on stop().
 */
export class AudioRecorder extends EventEmitter {
  private process: ChildProcess | null = null;
  private outputPath: string | null = null;
  private tempDir: string | null = null;
  private stopping = false;
  /**
   * Bounded tail of ffmpeg's stderr. The stream is piped, so it must be
   * read (an unread pipe can block the child) and it is the only place a
   * failed capture explains itself (N-F2).
   */
  private stderrBuffer = '';
  private readonly options: AudioRecorderOptions;
  private _state: RecorderState;

  constructor(options: AudioRecorderOptions = {}) {
    super();
    this.options = options;
    this._state = { status: 'idle', outputPath: null };
  }

  getState(): RecorderState {
    return this._state;
  }

  start(): string {
    if (this.process) {
      throw new Error('Recording already in progress');
    }

    const sampleRate = this.options.sampleRate || 16000;
    const channels = this.options.channels || 1;
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadabodha-'));
    this.outputPath = path.join(this.tempDir, `recording-${Date.now()}.wav`);

    const ffmpeg = this.options.ffmpegPath || 'ffmpeg';
    const args = [
      '-f', 'avfoundation',
      '-i', ':default',
      '-ar', String(sampleRate),
      '-ac', String(channels),
      '-sample_fmt', 's16',
      '-y',
      this.outputPath,
    ];

    this._state = { status: 'recording', outputPath: this.outputPath };
    this.stopping = false;
    this.stderrBuffer = '';

    try {
      this.process = spawn(ffmpeg, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this._state = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        outputPath: null,
      };
      this.process = null;
      this.cleanupTempDir();
      throw err;
    }

    // Drain stderr into a bounded tail (N-F2): an unread pipe can stall
    // ffmpeg, and this text is what surfaces on a failed capture.
    this.process.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(-4000);
    });

    this.process.on('error', (err) => {
      this._state = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        outputPath: this.outputPath,
      };
      this.emit('error', err);
      this.cleanup();
    });

    this.process.on('exit', (code, signal) => {
      const exitedUnexpectedly = code !== 0 && code !== null;
      const wasRecording = this._state.status === 'recording';
      // A stop() we initiated is expected to end the process; never report
      // it as a failure (F6: no spurious error on finalisation).
      if (wasRecording && exitedUnexpectedly && !this.stopping) {
        this._state = {
          status: 'error',
          error: `Recording process exited with code ${code} (signal ${signal})`,
          outputPath: this.outputPath,
        };
        this.emit('error', new Error(this._state.error || 'Recording failed'));
      }
      this.process = null;
    });

    return this.outputPath;
  }

  stop(): Promise<string | null> {
    const proc = this.process;
    if (!proc) {
      if (this._state.status === 'recording') {
        // ffmpeg already exited on its own (exit code 0 leaves the state
        // untouched); finalise the same way a normal stop would.
        const verified = this.verifyRecording();
        if (verified) {
          this._state = { status: 'idle', outputPath: verified };
        }
        return Promise.resolve(verified);
      }
      // Idle, errored, or already stopped: there is nothing to stop and a
      // previous session's path must never be replayed (N-F4, N-F1).
      return Promise.resolve(null);
    }

    this.stopping = true;

    return new Promise((resolve) => {
      let settled = false;
      let stdioGrace: NodeJS.Timeout | undefined;

      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(escalateTerm);
        clearTimeout(escalateKill);
        clearTimeout(stdioGrace);
        if (this.process === proc) {
          this.process = null;
        }
        this.stopping = false;
        if (this._state.status === 'error') {
          // ffmpeg never produced a usable file (e.g. binary missing);
          // its failure was already reported through the error event.
          resolve(null);
          return;
        }
        const verified = this.verifyRecording();
        if (verified) {
          this._state = { status: 'idle', outputPath: verified };
        }
        resolve(verified);
      };

      // Graceful interrupt first so ffmpeg finalises the WAV header, then
      // escalate: a recorder that ignores SIGINT must not hang stop() forever.
      const escalateTerm = setTimeout(() => {
        this.killSignal(proc, 'SIGTERM');
      }, 1500);
      const escalateKill = setTimeout(() => {
        this.killSignal(proc, 'SIGKILL');
      }, 4000);

      // 'close' fires only after the stdio pipes are drained, which is what
      // guarantees stderr is captured for verifyRecording()'s message.
      // 'exit' alone can arrive first, so give 'close' a short grace period
      // and settle anyway rather than wait on a stray process holding the
      // pipe open.
      proc.once('exit', () => {
        if (!settled && !stdioGrace) {
          stdioGrace = setTimeout(finish, 300);
        }
      });
      proc.once('close', finish);
      // A process that failed to spawn emits 'error' and never 'exit';
      // without this the promise would hang forever (F5).
      proc.once('error', finish);

      this.killSignal(proc, 'SIGINT');
    });
  }

  /**
   * Discard the current capture and forget its path (N-F1).
   *
   * Kills ffmpeg, removes the temp file and directory, and clears the
   * stored outputPath so a later stop() cannot return a deleted path or
   * start transcription on it. Always returns null: nothing is usable
   * after a cancel.
   */
  cancel(): string | null {
    if (this.process) {
      this.cleanup();
    }
    const output = this.outputPath;
    if (output && fs.existsSync(output)) {
      try {
        fs.unlinkSync(output);
      } catch {
        // Best-effort cleanup.
      }
    }
    this.cleanupTempDir();
    this.resetState();
    this.outputPath = null;
    return null;
  }

  /**
   * Confirm ffmpeg actually produced a usable recording: the WAV exists
   * and is non-empty.
   *
   * A failed mic capture can end with no file or a zero-byte file; handing
   * that path to transcription surfaces later as a confusing
   * "File not found: .../recording-*.wav" (N-F2/F11). Fail here instead,
   * quoting ffmpeg's own stderr so the UI shows a recording error.
   */
  private verifyRecording(): string | null {
    const output = this.outputPath;
    let size = -1;
    if (output) {
      try {
        size = fs.statSync(output).size;
      } catch {
        size = -1;
      }
    }
    if (output && size > 0) {
      return output;
    }
    const detail = this.stderrTail();
    const message = detail
      ? `Recording failed: ${detail}`
      : 'Recording failed: ffmpeg produced no recording file';
    this._state = { status: 'error', error: message, outputPath: null };
    this.emit('error', new Error(message));
    return null;
  }

  /** Last few non-empty stderr lines, for the failure message. */
  private stderrTail(maxLines = 3): string {
    return this.stderrBuffer
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-maxLines)
      .join(' | ');
  }

  /**
   * Signal the recording child only when it actually has a pid.
   *
   * `ChildProcess.kill()` on a process that never spawned (missing ffmpeg)
   * reports success and delivers the signal to pid 0, i.e. the whole process
   * group including the Electron main process. Guarding here is what keeps a
   * missing ffmpeg from taking the app down (F5).
   */
  private killSignal(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) {
      return;
    }
    try {
      proc.kill(signal);
    } catch {
      // Best-effort: the child may have exited between the check and the kill.
    }
  }

  private cleanup(): void {
    const proc = this.process;
    this.process = null;
    if (!proc) {
      return;
    }
    this.killSignal(proc, 'SIGTERM');
    // ffmpeg can block on the capture device and ignore SIGTERM (seen on hosts
    // without microphone access); escalate so teardown cannot leak a process.
    const escalate = setTimeout(() => this.killSignal(proc, 'SIGKILL'), 100);
    escalate.unref();
    proc.once('exit', () => clearTimeout(escalate));
  }

  private cleanupTempDir(): void {
    if (this.tempDir && fs.existsSync(this.tempDir)) {
      try {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
    this.tempDir = null;
  }

  private resetState(): void {
    this._state = { status: 'idle', outputPath: null };
  }
}
