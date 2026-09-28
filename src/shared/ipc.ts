/**
 * IPC channel names and payload shapes shared between main and renderer.
 */

export enum IpcChannel {
  StartRecording = 'start-recording',
  StopRecording = 'stop-recording',
  ImportAudio = 'import-audio',
  CancelTranscription = 'cancel-transcription',
  SaveTranscript = 'save-transcript',
  CopyTranscript = 'copy-transcript',
  TranscriptionEvent = 'transcription-event',
  RequestStatus = 'request-status',
}

export type TranscriptionStatus =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface TranscriptionEvent {
  status: TranscriptionStatus;
  text?: string;
  progress?: number; // 0-100 when transcribing
  error?: string;
}

export interface ImportAudioRequest {
  filePath: string;
}

export interface SaveTranscriptRequest {
  filePath: string;
  text: string;
}

export interface SaveTranscriptResult {
  success: boolean;
  filePath?: string;
  error?: string;
}
