import fs from 'fs';
import { SaveTranscriptRequest, SaveTranscriptResult } from '../shared/ipc';

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
  return savePlainText(request.filePath, request.text);
}
