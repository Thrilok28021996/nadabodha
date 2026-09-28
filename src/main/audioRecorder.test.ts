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

describe('AudioRecorder', () => {
  it('throws if start is called twice', () => {
    const recorder = new AudioRecorder();
    // Real ffmpeg runs here; cancel() must tear it down again.
    recorder.start();
    expect(() => recorder.start()).toThrow('Recording already in progress');
    recorder.cancel();
  });

  it('returns the output path after stop', async () => {
    const recorder = new AudioRecorder();
    const outputPath = recorder.start();
    expect(typeof outputPath).toBe('string');
    expect(path.isAbsolute(outputPath)).toBe(true);
    expect(recorder.getState().status).toBe('recording');

    const stoppedPath = await recorder.stop();
    expect(stoppedPath).toBe(outputPath);
    // Process should have exited.
    expect(recorder.getState().status).not.toBe('recording');
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
});
