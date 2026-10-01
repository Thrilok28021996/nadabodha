import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
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
 * Read the Hugging Face access token, trying multiple sources in priority order:
 *
 *  1. Token file written by `huggingface-cli login`
 *     (~/.cache/huggingface/token)
 *  2. Shell RC files (~/.zshenv, ~/.zshrc, ~/.zprofile, ~/.bash_profile, ~/.bashrc)
 *     and any files they `source` — handles the common case of
 *     `export HF_TOKEN=hf_...` in the user's shell config when Electron is
 *     launched from the dock and doesn't source RC files.
 *
 * Returns undefined when no token is found via any source.
 */
function readHfTokenFile(): string | undefined {
  // --- 1. huggingface-cli token file ---
  const tokenFileCandidates = [
    path.join(os.homedir(), '.cache', 'huggingface', 'token'),
    path.join(os.homedir(), '.huggingface', 'token'),
  ];
  for (const candidate of tokenFileCandidates) {
    try {
      const token = fs.readFileSync(candidate, 'utf8').trim();
      if (token) return token;
    } catch {
      // file doesn't exist or isn't readable — try next
    }
  }

  // --- 2. Shell RC files ---
  // Match with or without `export`, optional spaces around `=`, quoted or bare value.
  // e.g.  export HF_TOKEN=hf_abc   HF_TOKEN="hf_abc"   export HF_TOKEN = 'hf_abc'
  const tokenRe = /^\s*(?:export\s+)?HF_TOKEN\s*=\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/m;

  const rcRoots = [
    path.join(os.homedir(), '.zshenv'),
    path.join(os.homedir(), '.zshrc'),
    path.join(os.homedir(), '.zprofile'),
    path.join(os.homedir(), '.bash_profile'),
    path.join(os.homedir(), '.bashrc'),
  ];

  // Follow one level of `source` / `.` directives so tokens in sourced files
  // (e.g. ~/.secrets, ~/.env) are found too.
  const sourceRe = /^\s*(?:source|\.)\s+["']?([^\s"'#]+)["']?\s*(?:#.*)?$/gm;

  const visited = new Set<string>();

  function scanFile(filePath: string): string | undefined {
    const resolved = filePath.replace(/^~/, os.homedir());
    if (visited.has(resolved)) return undefined;
    visited.add(resolved);
    let content: string;
    try {
      content = fs.readFileSync(resolved, 'utf8');
    } catch {
      return undefined;
    }
    // Check for the token in this file first.
    const m = tokenRe.exec(content);
    if (m?.[1]) return m[1];
    // Follow source directives (one level deep).
    let sm: RegExpExecArray | null;
    sourceRe.lastIndex = 0;
    while ((sm = sourceRe.exec(content)) !== null) {
      const sourced = sm[1].replace(/\$HOME/g, os.homedir()).replace(/^~/, os.homedir());
      const found = scanFile(sourced);
      if (found) return found;
    }
    return undefined;
  }

  for (const rc of rcRoots) {
    const found = scanFile(rc);
    if (found) return found;
  }

  return undefined;
}

/**
 * Build the env block for the Python subprocess.
 *
 * Inherits the full parent environment and ensures HF_TOKEN is set —
 * first from the parent env (terminal launch), then from the token file
 * or shell RC (dock/Finder launch), then absent if no source has it.
 * Also disables xet transport to avoid its per-file connection overhead.
 */
function buildChildEnv(): NodeJS.ProcessEnv {
  const hfToken =
    process.env.HF_TOKEN ||
    process.env.HUGGING_FACE_HUB_TOKEN ||
    readHfTokenFile();

  return {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    HF_HUB_DISABLE_XET_TRANSPORT: '1',
    ...(hfToken ? { HF_TOKEN: hfToken } : {}),
  };
}

export function resolveDefaultPythonScriptPath(): string {
  if (process.resourcesPath) {
    const candidate = path.join(process.resourcesPath, 'python', 'nadabodha_transcribe.py');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const defaultPath = path.join(__dirname, '../../python/nadabodha_transcribe.py');
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }

  const unpacked = defaultPath.replace('app.asar', 'app.asar.unpacked');
  if (fs.existsSync(unpacked)) {
    return unpacked;
  }

  return defaultPath;
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
      resolveDefaultPythonScriptPath();

    this.process = spawn(python, [script, '--server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildChildEnv(),
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

    // Attach an error listener to stdin immediately. Without it, any EPIPE
    // (write after the child closed its end) becomes an unhandled 'error'
    // event that crashes the Electron main process.
    this.process.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
        this.options.onError(err);
      }
      // EPIPE / ERR_STREAM_DESTROYED: the child exited; the exit handler
      // already called onExit — no further action needed.
    });
  }

  startStream(repoId: string, cacheDir: string): NodeJS.WritableStream {
    if (this.process) {
      throw new Error('Transcription adapter already running');
    }

    const python = this.options.pythonExecutable || 'python3';
    const script =
      this.options.pythonScriptPath ||
      resolveDefaultPythonScriptPath();

    this.process = spawn(python, [script, '--stream', '--repo_id', repoId, '--cache_dir', cacheDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildChildEnv(),
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

    // Same EPIPE guard for the streaming stdin.
    this.process.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
        this.options.onError(err);
      }
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
    try {
      this.process.stdin.write(line);
    } catch (err: unknown) {
      // EPIPE means the child already closed its stdin end (it exited).
      // The 'exit' event handler will surface this as an onExit callback;
      // re-throwing here would be an uncaught exception that crashes the app.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPIPE' && code !== 'ERR_STREAM_DESTROYED') {
        throw err;
      }
    }
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
