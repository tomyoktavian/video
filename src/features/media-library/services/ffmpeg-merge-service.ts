import type { MergeWorkerFileInfo, MergeWorkerResponse } from '../workers/ffmpeg-merge-worker';
import { createLogger } from '@/shared/logging/logger';

const logger = createLogger('FFmpegMergeService');

export interface MergeProgressEvent {
  status: 'loading' | 'normalizing' | 'merging' | 'done' | 'error';
  text: string;
  progress: number; // 0-100
  currentFile?: number;
  totalFiles?: number;
}

export type MergeProgressCallback = (event: MergeProgressEvent) => void;

/**
 * FFmpeg Merge Service — delegates the entire merge pipeline to a dedicated
 * Web Worker so the main thread stays completely unblocked.
 *
 * Heavy operations (Blob→Uint8Array, FFmpeg FS I/O, large buffer copy) all
 * run inside the worker. The final merged ArrayBuffer is transferred
 * (zero-copy) back to the main thread and wrapped in a Blob.
 *
 * Performance optimizations:
 *  - FFmpeg core loaded from same origin (no CDN download)
 *  - Smart normalization skip for compatible codec batches
 *  - Preload support to eliminate load latency at merge time
 */
class FFmpegMergeService {
  private worker: Worker | null = null;
  private preloadPromise: Promise<void> | null = null;

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(
        new URL('../workers/ffmpeg-merge-worker.ts', import.meta.url),
        { type: 'module' },
      );
    }
    return this.worker;
  }

  /**
   * Preload FFmpeg engine in the background.
   *
   * Call this early (e.g. when 2+ videos are selected) so the engine
   * is ready by the time the user clicks "Merge". Idempotent — multiple
   * calls share the same loading promise.
   */
  preload(): Promise<void> {
    if (this.preloadPromise) return this.preloadPromise;

    this.preloadPromise = new Promise<void>((resolve, reject) => {
      const worker = this.getWorker();
      const channel = new MessageChannel();

      channel.port1.onmessage = (event: MessageEvent<MergeWorkerResponse>) => {
        const data = event.data;
        if (data.kind === 'result') {
          channel.port1.close();
          if (data.success) {
            logger.info('FFmpeg engine preloaded');
            resolve();
          } else {
            reject(new Error(data.error || 'Preload failed'));
          }
        }
      };

      worker.postMessage({ type: 'preload' }, [channel.port2]);
    });

    return this.preloadPromise;
  }

  /**
   * Merge multiple video Blobs into a single MP4.
   *
   * The entire pipeline (load FFmpeg, normalize segments, concat, read output)
   * runs in a Web Worker. Progress events are streamed back via MessageChannel.
   *
   * Pass codec metadata to enable smart normalization skip for compatible files.
   *
   * @param files - Array of file info with blob and optional codec metadata
   * @param onProgress - Throttled progress callback (max ~4 updates/sec from worker)
   * @returns Merged video as a Blob
   */
  mergeVideos(
    files: MergeWorkerFileInfo[],
    onProgress?: MergeProgressCallback,
  ): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const worker = this.getWorker();
      const channel = new MessageChannel();

      channel.port1.onmessage = (event: MessageEvent<MergeWorkerResponse>) => {
        const data = event.data;

        if (data.kind === 'progress') {
          onProgress?.({
            status: data.status,
            text: data.text,
            progress: data.progress,
            currentFile: data.currentFile,
            totalFiles: data.totalFiles,
          });
          return;
        }

        // kind === 'result'
        if (data.success && data.buffer) {
          const blob = new Blob([data.buffer], { type: 'video/mp4' });
          resolve(blob);
        } else {
          reject(new Error(data.error || 'Merge failed'));
        }

        // Close the channel
        channel.port1.close();
      };

      // Send file info to the worker. Blobs are cloneable via structured clone,
      // so they cross the worker boundary efficiently without copying bytes.
      worker.postMessage(
        { type: 'merge', files },
        [channel.port2],
      );
    });
  }

  /**
   * Terminate the worker and free resources.
   */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.preloadPromise = null;
      logger.info('FFmpeg merge worker terminated');
    }
  }
}

// Singleton
export const ffmpegMergeService = new FFmpegMergeService();
