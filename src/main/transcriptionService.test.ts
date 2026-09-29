import fs from 'fs';
import path from 'path';
import os from 'os';
import { TranscriptionService } from './transcriptionService';

function makeWav(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadabodha-test-'));
  const wav = path.join(tmpDir, 'test.wav');
  // Minimal valid 16-bit 16kHz mono WAV: header + silence
  const sampleRate = 16000;
  const duration = 0.05;
  const numSamples = Math.floor(sampleRate * duration);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(wav, buffer);
  return wav;
}

jest.setTimeout(20000);

describe('TranscriptionService', () => {
  it('starts in idle state', () => {
    const service = new TranscriptionService();
    expect(service.getState()).toBe('idle');
    expect(service.getTranscript()).toBe('');
  });

  it('transitions through transcribing to completed with mock adapter', (done) => {
    const service = new TranscriptionService();
    const events: { status: string; progress?: number }[] = [];
    service.onEvent((event) => events.push(event));

    const wav = makeWav();
    service.startTranscription(wav);

    const check = setInterval(() => {
      if (service.getState() === 'completed' || service.getState() === 'error') {
        clearInterval(check);
        try {
          expect(service.getState()).toBe('completed');
          expect(service.getTranscript()).toContain('Mock transcript');
          const statuses = events.map((e) => e.status);
          expect(statuses).toContain('transcribing');
          expect(statuses).toContain('completed');
          done();
        } catch (err) {
          done(err);
        }
      }
    }, 100);
  });

  it('reports error for missing file', (done) => {
    const service = new TranscriptionService();
    service.onEvent((event) => {
      if (event.status === 'error') {
        expect(event.error).toContain('File not found');
        expect(service.getState()).toBe('error');
        done();
      }
    });
    service.startTranscription('/does/not/exist.wav');
  });

  it('allows cancellation', (done) => {
    const service = new TranscriptionService();
    const wav = makeWav();
    service.startTranscription(wav);
    service.cancel();
    setTimeout(() => {
      expect(service.getState()).toBe('cancelled');
      done();
    }, 150);
  });

  it('forwards interleaved download events without touching transcription state', () => {
    const service = new TranscriptionService();
    const events: { status: string; origin?: string; progress?: number }[] = [];
    service.onEvent((event) => events.push(event));

    const internal = service as unknown as {
      handleAdapterEvent: (event: { status: string; origin?: string; progress?: number }) => void;
    };
    internal.handleAdapterEvent({ status: 'downloading', origin: 'download', progress: 40 });
    internal.handleAdapterEvent({ status: 'completed', origin: 'download' });

    // state machine must stay untouched by download events
    expect(service.getState()).toBe('idle');
    expect(service.getTranscript()).toBe('');
    expect(events).toEqual([
      { status: 'downloading', origin: 'download', progress: 40 },
      { status: 'completed', origin: 'download' },
    ]);
  });
});
