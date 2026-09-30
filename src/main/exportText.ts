import fs from 'fs';
import { SaveTranscriptRequest, SaveTranscriptResult } from '../shared/ipc';

function formatTimestampSrt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

function formatTimestampVtt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

/**
 * Saves transcript text as plain UTF-8.
 */
export function savePlainText(
  filePath: string,
  text: string
): SaveTranscriptResult {
  if (!filePath || !text) {
    return { success: false, error: 'filePath and text are required' };
  }
  try {
    fs.writeFileSync(filePath, text, 'utf8');
    return { success: true, filePath };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function saveTranscript(request: SaveTranscriptRequest): SaveTranscriptResult {
  if (request.format === 'srt' && request.words) {
    let srt = '';
    let index = 1;
    // Basic sentence chunking from words for SRT
    const words = request.words;
    const chunkSize = 10;
    for (let i = 0; i < words.length; i += chunkSize) {
      const chunk = words.slice(i, i + chunkSize);
      const start = chunk[0].start;
      const end = chunk[chunk.length - 1].end;
      const text = chunk.map(w => w.word).join(' ');
      srt += `${index}\n${formatTimestampSrt(start)} --> ${formatTimestampSrt(end)}\n${text.trim()}\n\n`;
      index++;
    }
    return savePlainText(request.filePath, srt);
  } else if (request.format === 'vtt' && request.words) {
    let vtt = 'WEBVTT\n\n';
    const words = request.words;
    const chunkSize = 10;
    for (let i = 0; i < words.length; i += chunkSize) {
      const chunk = words.slice(i, i + chunkSize);
      const start = chunk[0].start;
      const end = chunk[chunk.length - 1].end;
      const text = chunk.map(w => w.word).join(' ');
      vtt += `${formatTimestampVtt(start)} --> ${formatTimestampVtt(end)}\n${text.trim()}\n\n`;
    }
    return savePlainText(request.filePath, vtt);
  }
  return savePlainText(request.filePath, request.text);
}
