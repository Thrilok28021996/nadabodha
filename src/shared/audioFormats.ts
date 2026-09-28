/**
 * Supported audio import formats and validation helpers.
 */

export const SUPPORTED_IMPORT_EXTENSIONS = [
  '.wav',
  '.mp3',
  '.m4a',
  '.ogg',
  '.flac',
  '.aac',
  '.aiff',
  '.wma',
];

export const SUPPORTED_IMPORT_MIME_TYPES: string[] = [
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
  'audio/aac',
  'audio/x-aac',
  'audio/aiff',
  'audio/x-aiff',
  'audio/x-ms-wma',
];

export function isSupportedAudioFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SUPPORTED_IMPORT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function getAudioExtension(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  return SUPPORTED_IMPORT_EXTENSIONS.find((ext) => lower.endsWith(ext));
}
