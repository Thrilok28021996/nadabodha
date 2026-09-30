import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import {
  friendlyRecordingFailure,
  isMicrophoneCaptureFailure,
  MICROPHONE_DENIED_MESSAGE,
} from './micPermission';

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
  /**
   * System-audio (meeting) executable. Defaults to `catap` from PATH; point
   * it at a path that cannot exist to exercise the missing-binary path
   * without depending on the caller's environment (mirrors ffmpegPath).
   */
  catapPath?: string;
}

interface RecorderState {
  status: 'idle' | 'recording' | 'error';
  error?: string;
  /**
   * D3: system-audio (catap) capture failed while the microphone recording
   * kept going. Surfaced as-is so meeting mode degrades to mic-only with a
   * human-readable reason instead of taking the app down.
   */
  meetingError?: string;
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
  private systemProcess: ChildProcess | null = null;
  private outputPath: string | null = null;
  private systemOutputPath: string | undefined = undefined;
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

  getStream() {
    return this.process?.stdout || null;
  }

  start(options?: { meetingMode?: boolean }): { micPath: string; systemPath?: string } {
    if (this.process || this.systemProcess) {
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
      // Tee to stdout as raw PCM for streaming
      '-f', 's16le',
      '-ar', String(sampleRate),
      '-ac', String(channels),
      'pipe:1',
    ];

    this._state = { status: 'recording', outputPath: this.outputPath };
    this.stopping = false;
    this.stderrBuffer = '';

    try {
      this.process = spawn(ffmpeg, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      
      if (options?.meetingMode) {
        this.systemOutputPath = path.join(this.tempDir, `system-${Date.now()}.wav`);
        const systemProc = spawn(this.options.catapPath || 'catap', [
          'record', '--system', '--mono', '-o', this.systemOutputPath
        ], {
          stdio: 'ignore'
        });
        this.systemProcess = systemProc;
        this.attachSystemProcessHandlers(systemProc);
      }
    } catch (err) {
      this._state = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        outputPath: null,
      };
      this.process = null;
      if (this.systemProcess) {
        this.killSignal(this.systemProcess, 'SIGKILL');
        this.systemProcess = null;
      }
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
      const proc = this.process;
      const exitedUnexpectedly = code !== 0 && code !== null;
      const wasRecording = this._state.status === 'recording';
      // A stop() we initiated is expected to end the process; never report
      // it as a failure (F6: no spurious error on finalisation).
      if (wasRecording && exitedUnexpectedly && !this.stopping) {
        const exitSummary = `Recording process exited with code ${code} (signal ${signal})`;
        this._state = {
          status: 'error',
          error: this.exitFailureMessage(exitSummary, code),
          outputPath: this.outputPath,
        };
        this.emit('error', new Error(this._state.error || exitSummary));
        // stderr may still be draining; refine the message once it has closed.
        this.refineExitFailure(proc, code);
      }
      this.process = null;
    });

    return { micPath: this.outputPath, systemPath: this.systemOutputPath };
  }

  stop(): Promise<{ micPath: string; systemPath?: string } | null> {
    const proc = this.process;
    if (!proc) {
      if (this._state.status === 'recording') {
        // ffmpeg already exited on its own (exit code 0 leaves the state
        // untouched); finalise the same way a normal stop would.
        const verified = this.verifyRecording();
        if (verified) {
          this._state = { status: 'idle', outputPath: verified.micPath };
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
        if (this.systemProcess) {
          this.killSignal(this.systemProcess, 'SIGINT');
          const sysEsc = setTimeout(() => this.systemProcess && this.killSignal(this.systemProcess, 'SIGTERM'), 1500);
          const sysKill = setTimeout(() => {
            if (this.systemProcess) {
              this.killSignal(this.systemProcess, 'SIGKILL');
              this.systemProcess = null;
            }
          }, 4000);
          this.systemProcess.once('exit', () => { clearTimeout(sysEsc); clearTimeout(sysKill); this.systemProcess = null; });
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
          this._state = { status: 'idle', outputPath: verified.micPath };
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
    if (this.process || this.systemProcess) {
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
    const sysOutput = this.systemOutputPath;
    if (sysOutput && fs.existsSync(sysOutput)) {
      try {
        fs.unlinkSync(sysOutput);
      } catch {
        // Best-effort cleanup.
      }
    }
    this.cleanupTempDir();
    this.resetState();
    this.outputPath = null;
    this.systemOutputPath = undefined;
    return null;
  }

  /**
   * D3: a ChildProcess 'error' (ENOENT when `catap` is not on PATH) has no
   * synchronous catch — with no listener Node treats it as uncaught and the
   * Electron main process dies. Meeting capture instead degrades to
   * mic-only: the failure lands on the recorder state (and the
   * 'meeting-error' event, which the IPC layer forwards to the renderer),
   * the microphone process keeps recording, and the dead reference is
   * cleared so stop()/cancel() never touch it. This handler never throws.
   */
  private attachSystemProcessHandlers(systemProc: ChildProcess): void {
    systemProc.on('error', (err) => {
      try {
        const detail = err instanceof Error ? err.message : String(err);
        const message = detail.includes('ENOENT')
          ? `System audio not captured: \`catap\` was not found on PATH. Meeting mode recorded the microphone only.`
          : `System audio capture failed: ${detail}`;
        if (this.systemProcess === systemProc) {
          // Safe even for a stale session: only clear when this process
          // still owns the slot, and never leave a phantom system path for
          // verifyRecording()/transcription to report.
          this.systemProcess = null;
          this.systemOutputPath = undefined;
        }
        this._state = { ...this._state, meetingError: message };
        this.emit('meeting-error', message);
      } catch {
        // An 'error' listener must never throw, whatever happens above.
      }
    });
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
  private verifyRecording(): { micPath: string; systemPath?: string } | null {
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
      return { micPath: output, systemPath: this.systemOutputPath };
    }
    const detail = this.stderrTail();
    const base = detail
      ? `Recording failed: ${detail}`
      : 'Recording failed: ffmpeg produced no recording file';
    const message = friendlyRecordingFailure(base, this.stderrBuffer);
    this._state = { status: 'error', error: message, outputPath: null };
    this.emit('error', new Error(message));
    return null;
  }

  /**
   * Failure text for an ffmpeg that exited on its own. When stderr already
   * shows a blocked capture device, lead with the microphone guidance and
   * keep ffmpeg's own detail as the secondary `Recording failed:` text; any
   * other exit keeps its original summary, unchanged.
   */
  private exitFailureMessage(exitSummary: string, code: number | null): string {
    if (!isMicrophoneCaptureFailure(this.stderrBuffer)) {
      return exitSummary;
    }
    const detail = this.stderrTail() || `ffmpeg exited with code ${code}`;
    return friendlyRecordingFailure(`Recording failed: ${detail}`, this.stderrBuffer);
  }

  /**
   * stderr is piped, so its last lines can still be draining when 'exit'
   * fires — and that text is the only place a permission failure explains
   * itself. Once the pipe has closed, republish the error with the microphone
   * guidance if the drained text shows a blocked capture device. The guards
   * make a second event impossible unless the first message lacked the
   * guidance, and impossible after cancel() or a later recording session.
   */
  private refineExitFailure(proc: ChildProcess | null, code: number | null): void {
    const stream = proc?.stderr;
    if (!stream || stream.destroyed || stream.readableEnded) {
      // All stderr lines were already delivered before 'exit'; the message
      // composed there is final.
      return;
    }
    const refine = (): void => {
      if (this.process !== null) {
        return; // a later session owns the recorder
      }
      if (this._state.status !== 'error') {
        return; // cancelled or reset in the meantime
      }
      if (!isMicrophoneCaptureFailure(this.stderrBuffer)) {
        return;
      }
      if ((this._state.error || '').startsWith(MICROPHONE_DENIED_MESSAGE)) {
        return; // already guided; never publish twice
      }
      const detail = this.stderrTail() || `ffmpeg exited with code ${code}`;
      const message = friendlyRecordingFailure(`Recording failed: ${detail}`, this.stderrBuffer);
      this._state = { ...this._state, error: message };
      this.emit('error', new Error(message));
    };
    stream.once('close', refine);
    stream.once('end', refine);
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
