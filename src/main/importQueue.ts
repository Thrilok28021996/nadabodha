import { TranscriptionService } from './transcriptionService';
import { TranscriptionEvent, ImportItem } from '../shared/ipc';

export class ImportQueue {
  private queue: ImportItem[] = [];
  private service: TranscriptionService;
  private isProcessing = false;
  private currentId: string | null = null;
  public onEvent?: (queue: ImportItem[]) => void;

  constructor(service: TranscriptionService) {
    this.service = service;
    this.service.onEvent((event: TranscriptionEvent) => {
      if (!this.currentId) return;
      const item = this.queue.find(i => i.id === this.currentId);
      if (!item) return;

      if (event.status === 'transcribing') {
        item.status = 'transcribing';
        item.progress = event.progress || 0;
        this.emit();
      } else if (event.status === 'completed') {
        item.status = 'completed';
        item.progress = 100;
        item.text = event.text;
        this.currentId = null;
        this.emit();
        this.processNext();
      } else if (event.status === 'error') {
        item.status = 'error';
        item.error = event.error;
        this.currentId = null;
        this.emit();
        this.processNext();
      } else if (event.status === 'cancelled') {
        if (this.currentId) {
          // If we are currently processing, a cancel means the transcription was cancelled.
          item.status = 'cancelled';
          this.currentId = null;
        }
        this.emit();
        this.processNext();
      }
    });
  }

  add(filePath: string): string {
    const id = Date.now().toString() + Math.random().toString();
    this.queue.push({
      id,
      filePath,
      progress: 0,
      status: 'pending',
    });
    this.emit();
    this.processNext();
    return id;
  }

  cancel(id: string) {
    const item = this.queue.find(i => i.id === id);
    if (!item) return;
    if (item.status === 'transcribing' && this.currentId === id) {
      this.service.cancel();
    } else if (item.status === 'pending') {
      item.status = 'cancelled';
      this.emit();
    }
  }

  remove(id: string) {
    this.cancel(id);
    this.queue = this.queue.filter(i => i.id !== id);
    this.emit();
  }

  private processNext() {
    if (this.isProcessing && this.currentId) return;
    const next = this.queue.find(i => i.status === 'pending');
    if (!next) {
      this.isProcessing = false;
      return;
    }
    const state = this.service.getState();
    if (state === 'recording' || state === 'transcribing') {
        // We cannot start right now because transcription is already busy
        // Wait for it to become idle. The next completed/cancelled event 
        // will naturally call processNext again.
        return;
    }

    this.isProcessing = true;
    this.currentId = next.id;
    next.status = 'transcribing';
    this.emit();
    this.service.startTranscription(next.filePath, { origin: 'transcription' });
  }

  private emit() {
    if (this.onEvent) {
      this.onEvent(this.queue);
    }
  }
}
