import fs from 'fs';
import path from 'path';
import { ImportQueue } from './importQueue';
import { isSupportedAudioFile } from '../shared/audioFormats';

export class WatchFolder {
  private dirPath: string;
  private queue: ImportQueue;
  private interval: NodeJS.Timeout | null = null;
  private processed: Set<string> = new Set();
  private pending: Map<string, { size: number; mtimeMs: number; stableCount: number }> = new Map();

  constructor(dirPath: string, queue: ImportQueue) {
    this.dirPath = dirPath;
    this.queue = queue;
  }

  start() {
    if (this.interval) return;
    if (!fs.existsSync(this.dirPath)) {
      try {
        fs.mkdirSync(this.dirPath, { recursive: true });
      } catch (err) {
        console.error('WatchFolder: Failed to create watch dir', err);
        return;
      }
    }
    this.interval = setInterval(() => {
      this.poll();
    }, 5000);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private poll() {
    try {
      const files = fs.readdirSync(this.dirPath);
      const currentFiles = new Set<string>();

      for (const file of files) {
        const fullPath = path.join(this.dirPath, file);
        currentFiles.add(fullPath);

        if (this.processed.has(fullPath)) continue;
        if (!isSupportedAudioFile(fullPath)) continue;

        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }

        if (!stat.isFile()) continue;

        const p = this.pending.get(fullPath);
        if (!p) {
          this.pending.set(fullPath, { size: stat.size, mtimeMs: stat.mtimeMs, stableCount: 0 });
        } else {
          if (p.size === stat.size && p.mtimeMs === stat.mtimeMs) {
            p.stableCount++;
            if (p.stableCount >= 1) {
              this.processed.add(fullPath);
              this.pending.delete(fullPath);
              this.queue.add(fullPath);
            }
          } else {
            p.size = stat.size;
            p.mtimeMs = stat.mtimeMs;
            p.stableCount = 0;
          }
        }
      }

      for (const [p] of this.pending) {
        if (!currentFiles.has(p)) {
          this.pending.delete(p);
        }
      }
    } catch (err) {
      console.error('WatchFolder poll error', err);
    }
  }
}
