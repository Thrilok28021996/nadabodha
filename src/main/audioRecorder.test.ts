import fs from 'fs';
import path from 'path';
import os from 'os';
import { AudioRecorder } from './audioRecorder';

jest.setTimeout(15000);

/** Poll until `predicate` holds, or fail after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Create a temp bin dir with a path reserved for a fake `ffmpeg`. */
function makeFakeFfmpegDir(): { binDir: string; ffmpegPath: string } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadabodha-fake-ffmpeg-'));
  return { binDir, ffmpegPath: path.join(binDir, 'ffmpeg') };
}

/** Write an executable sh stand-in for ffmpeg at `ffmpegPath`. */
function writeFakeScript(ffmpegPath: string, body: string): void {
  fs.writeFileSync(ffmpegPath, `#!/bin/sh\n${body}`);
  fs.chmodSync(ffmpegPath, 0o755);
}

describe('AudioRecorder', () => {
  it('throws if start is called twice', () => {
    const recorder = new AudioRecorder();
    // Real ffmpeg runs here; cancel() must tear it down again.
    recorder.start();
    expect(() => recorder.start()).toThrow('Recording already in progress');
    recorder.cancel();
  });

  it('returns the output path after stop only when ffmpeg produced a real file', async () => {
    const recorder = new AudioRecorder();
    const errors: Error[] = [];
    recorder.on('error', (err: Error) => errors.push(err));

    const outputPath = recorder.start();
    expect(typeof outputPath).toBe('string');
    expect(path.isAbsolute(outputPath)).toBe(true);
    expect(recorder.getState().status).toBe('recording');

    const stoppedPath = await recorder.stop();
    // Process should have exited.
    expect(recorder.getState().status).not.toBe('recording');

    if (stoppedPath === null) {
      // Host has no usable microphone (N-F2/F11): stop must fail loudly
      // instead of handing transcription a phantom path.
      expect(recorder.getState().status).toBe('error');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[errors.length - 1].message).toContain('Recording failed:');
    } else {
      expect(stoppedPath).toBe(outputPath);
      expect(fs.existsSync(stoppedPath)).toBe(true);
      expect(fs.statSync(stoppedPath).size).toBeGreaterThan(0);
      expect(errors).toHaveLength(0);
    }
  });

  it('cleans up temp file on cancel', async () => {
    const recorder = new AudioRecorder();
    const outputPath = recorder.start();
    const tempDir = path.dirname(outputPath);
    try {
      // ffmpeg creates the file only after it opens the output, on a later
      // tick, so poll rather than asserting synchronously. On hosts where the
      // microphone cannot be opened ffmpeg writes nothing at all.
      await waitFor(() => fs.existsSync(outputPath), 4000);
    } catch {
      // No microphone access on this host; cleanup is still asserted below.
    }
    expect(fs.existsSync(tempDir)).toBe(true);

    recorder.cancel();
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(tempDir)).toBe(false);

    // Let the terminated ffmpeg be reaped before the suite ends, so the test
    // worker does not exit with a live child-process handle.
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  it('reports error state when ffmpeg is missing', async () => {
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'nadabodha-empty-bin-'));
    try {
      // Jest sandboxes process.env, so mutating PATH does not reach spawn();
      // point the recorder at a binary path that cannot exist instead.
      const recorder = new AudioRecorder({ ffmpegPath: path.join(emptyBin, 'ffmpeg') });
      const errors: Error[] = [];
      recorder.on('error', (err: Error) => errors.push(err));

      recorder.start();
      const stoppedPath = await recorder.stop();

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('ENOENT');
      expect(recorder.getState().status).toBe('error');
      // stop() must settle even though the process never spawned (F5).
      expect(stoppedPath).toBeNull();
    } finally {
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  it('stop-with-no-file: resolves null with a recording error, not a phantom path (N-F2)', async () => {
    const { binDir, ffmpegPath } = makeFakeFfmpegDir();
    try {
      // Stays alive until signalled but never writes a WAV: the shape of a
      // failed mic capture. No child processes, so teardown cannot leak.
      writeFakeScript(ffmpegPath, "trap 'exit 1' INT TERM\nwhile true; do :; done\n");

      const recorder = new AudioRecorder({ ffmpegPath });
      const errors: Error[] = [];
      recorder.on('error', (err: Error) => errors.push(err));

      const outputPath = recorder.start();
      expect(recorder.getState().status).toBe('recording');

      const stoppedPath = await recorder.stop();

      expect(stoppedPath).toBeNull();
      expect(recorder.getState().status).toBe('error');
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[errors.length - 1].message).toContain('Recording failed:');
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('stop-surfaces-stderr: failed capture reports ffmpeg stderr via the error event (N-F2)', async () => {
    const { binDir, ffmpegPath } = makeFakeFfmpegDir();
    const marker = path.join(binDir, 'exited');
    try {
      // Writes the capture failure to stderr, marks completion, exits 0
      // without ever creating the output file.
      writeFakeScript(
        ffmpegPath,
        [
          'echo "avfoundation: cannot use MacBook Air Microphone" >&2',
          'echo "Error opening input: :default" >&2',
          `touch "${marker}"`,
          'exit 0',
          '',
        ].join('\n')
      );

      const recorder = new AudioRecorder({ ffmpegPath });
      const errors: Error[] = [];
      recorder.on('error', (err: Error) => errors.push(err));

      const outputPath = recorder.start();
      // Let the fake ffmpeg write stderr and exit; a small extra delay
      // ensures the piped stderr has been drained by this process.
      await waitFor(() => fs.existsSync(marker), 5000);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const stoppedPath = await recorder.stop();

      expect(stoppedPath).toBeNull();
      expect(recorder.getState().status).toBe('error');
      expect(fs.existsSync(outputPath)).toBe(false);
      const message = errors.map((err) => err.message).join('\n');
      expect(message).toContain('Recording failed:');
      expect(message).toContain('avfoundation: cannot use MacBook Air Microphone');
      expect(message).toContain('Error opening input: :default');
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('stop-after-cancel: returns null and never revives the deleted capture (N-F1)', async () => {
    const recorder = new AudioRecorder();
    const errors: Error[] = [];
    recorder.on('error', (err: Error) => errors.push(err));

    const outputPath = recorder.start();
    const tempDir = path.dirname(outputPath);

    expect(recorder.cancel()).toBeNull();
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(tempDir)).toBe(false);

    const stoppedPath = await recorder.stop();
    expect(stoppedPath).toBeNull();
    expect(recorder.getState().status).toBe('idle');
    // Nothing failed; cancel/stop must not fabricate recording errors.
    expect(errors).toHaveLength(0);

    // Let the terminated ffmpeg be reaped before the suite ends.
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  it('stop-idle: returns null when nothing is recording (N-F4)', async () => {
    const recorder = new AudioRecorder();
    expect(await recorder.stop()).toBeNull();
    expect(recorder.getState().status).toBe('idle');
  });

  it('stop twice: the second stop never replays the previous session path (N-F4)', async () => {
    const recorder = new AudioRecorder();
    const errors: Error[] = [];
    recorder.on('error', (err: Error) => errors.push(err));

    recorder.start();
    const firstStop = await recorder.stop();
    const secondStop = await recorder.stop();

    expect(secondStop).toBeNull();
    if (firstStop !== null) {
      expect(fs.existsSync(firstStop)).toBe(true);
      expect(fs.statSync(firstStop).size).toBeGreaterThan(0);
    }
  });
});
