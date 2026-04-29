/**
 * Download Utils
 *
 * Shared utility for downloading online media files.
 * Both single downloads (from MediaCard) and bulk downloads (Download All)
 * use the same pipeline:
 *
 *  1. Fetch runs in a dedicated Web Worker → zero main-thread blocking
 *  2. Progress is posted back via postMessage (~4 updates/sec)
 *  3. ArrayBuffer is transferred (zero-copy) to main thread
 *  4. importOnlineMedia handles metadata + OPFS persistence
 */

import { createLogger } from "@/shared/logging/logger";
import { mediaLibraryService } from "../services/media-library-service";
import type { DownloadWorkerResponse } from "../workers/media-download-worker";
import type { OnlineEpisode } from "../components/media-card";

const logger = createLogger("DownloadUtils");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DownloadProgress {
  /** Bytes downloaded so far */
  downloaded: number;
  /** Total bytes (from Content-Length) */
  total: number;
  /** Download speed in bytes/sec */
  speed: number;
  /** Current phase */
  phase: "downloading" | "processing" | "saving";
  /** File being downloaded */
  fileName: string;
  /** Current episode index (0-based) when downloading multiple */
  episodeIndex: number;
  /** Total episodes to download */
  totalEpisodes: number;
}

// ─── Worker singleton ────────────────────────────────────────────────────────

let downloadWorker: Worker | null = null;

function getDownloadWorker(): Worker {
  if (!downloadWorker) {
    downloadWorker = new Worker(
      new URL("../workers/media-download-worker.ts", import.meta.url),
      { type: "module" },
    );
  }
  return downloadWorker;
}

// ─── Cancellation ────────────────────────────────────────────────────────────

/** Shared AbortController for the current download session */
let currentAbortController: AbortController | null = null;

/** Cancel all active downloads. Safe to call even when nothing is downloading. */
export function cancelAllDownloads(): void {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  // Terminate and recreate worker to abort in-flight fetch
  if (downloadWorker) {
    downloadWorker.terminate();
    downloadWorker = null;
  }
}

// ─── Low-level: download a URL in the worker ────────────────────────────────

function downloadInWorker(
  url: string,
  onProgress?: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    // Check if already aborted
    if (signal?.aborted) {
      reject(new DOMException("Download cancelled", "AbortError"));
      return;
    }

    const worker = getDownloadWorker();
    const id = crypto.randomUUID();

    const cleanup = () => {
      worker.removeEventListener("message", handler);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException("Download cancelled", "AbortError"));
    };

    const handler = (e: MessageEvent<DownloadWorkerResponse>) => {
      if (e.data.id !== id) return;

      switch (e.data.type) {
        case "progress":
          onProgress?.(e.data.downloaded, e.data.total);
          break;
        case "complete":
          cleanup();
          resolve({ buffer: e.data.buffer, contentType: e.data.contentType });
          break;
        case "error":
          cleanup();
          reject(new Error(e.data.error));
          break;
      }
    };

    signal?.addEventListener("abort", onAbort);
    worker.addEventListener("message", handler);
    worker.postMessage({ type: "download", id, url });
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse file extension from URL pathname */
function parseUrlExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").pop() || "";
    const dotIdx = lastSegment.lastIndexOf(".");
    if (dotIdx > 0) {
      const ext = lastSegment.slice(dotIdx + 1).toLowerCase();
      if (ext.length <= 5 && /^[a-z0-9]+$/.test(ext)) return ext;
    }
  } catch {
    /* invalid URL */
  }
  return "mp4";
}

/** Build a safe file name for an episode */
export function buildEpisodeFileName(
  ep: OnlineEpisode,
  originalIndex: number,
): string {
  const ext = ep.url ? parseUrlExtension(ep.url) : "mp4";
  const safeName = (ep.dramaTitle || "episode").replace(/[^a-z0-9]/gi, "_");
  return `${originalIndex + 1}-${safeName}.${ext}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface DownloadMediaOptions {
  url: string;
  fileName: string;
  projectId: string;
  thumbnailDataUrl?: string;
  onlineDuration?: number;
  /** Progress callback */
  onProgress?: (progress: DownloadProgress) => void;
  /** Episode index when downloading multiple (default: 0) */
  episodeIndex?: number;
  /** Total episodes count (default: 1) */
  totalEpisodes?: number;
}

/**
 * Download a single online media file and import it into the project.
 *
 * The fetch runs in a Web Worker — main thread stays completely free.
 * Returns `true` on success, `false` on failure.
 */
export async function downloadAndImportMedia(
  opts: DownloadMediaOptions,
  signal?: AbortSignal,
): Promise<boolean> {
  const {
    url,
    fileName,
    projectId,
    thumbnailDataUrl,
    onlineDuration,
    onProgress,
    episodeIndex = 0,
    totalEpisodes = 1,
  } = opts;

  const ext = parseUrlExtension(url);
  const finalFileName = fileName.includes(".")
    ? fileName
    : `${fileName}.${ext}`;
  const startTime = Date.now();

  try {
    // ── Phase 1: Download in worker (completely off main thread) ──
    onProgress?.({
      downloaded: 0,
      total: 0,
      speed: 0,
      phase: "downloading",
      fileName: finalFileName,
      episodeIndex,
      totalEpisodes,
    });

    const { buffer, contentType } = await downloadInWorker(
      url,
      (downloaded, total) => {
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? downloaded / elapsed : 0;
        onProgress?.({
          downloaded,
          total,
          speed,
          phase: "downloading",
          fileName: finalFileName,
          episodeIndex,
          totalEpisodes,
        });
      },
      signal,
    );

    // Check cancellation before heavy import phase
    if (signal?.aborted) return false;

    // ── Phase 2: Import (metadata extraction in worker + OPFS save) ──
    onProgress?.({
      downloaded: buffer.byteLength,
      total: buffer.byteLength,
      speed: 0,
      phase: "processing",
      fileName: finalFileName,
      episodeIndex,
      totalEpisodes,
    });

    const mimeType = contentType || `video/${ext}`;
    const blob = new Blob([buffer], { type: mimeType });

    await mediaLibraryService.importOnlineMedia(url, fileName, projectId, {
      thumbnailDataUrl,
      onlineDuration,
      preDownloadedBlob: blob,
    });

    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      return false;
    logger.error(`Failed to download ${finalFileName}:`, error);
    return false;
  }
}

/**
 * Download multiple episodes sequentially.
 * Each download runs in the Web Worker. UI stays responsive.
 */
export async function downloadAllMedia(
  episodes: Array<{
    episode: OnlineEpisode;
    originalIndex: number;
  }>,
  projectId: string,
  callbacks: {
    onProgress?: (progress: DownloadProgress) => void;
    onEpisodeStart?: (url: string) => void;
    onEpisodeComplete?: (url: string, success: boolean) => void;
  } = {},
): Promise<number> {
  // Create a new AbortController for this download session
  currentAbortController = new AbortController();
  const { signal } = currentAbortController;

  let importedCount = 0;

  for (let i = 0; i < episodes.length; i++) {
    // Check cancellation before starting next episode
    if (signal.aborted) break;

    const entry = episodes[i];
    if (!entry?.episode.url) continue;

    // Yield to event loop so UI can process pending events.
    // Use setTimeout (not requestAnimationFrame) because rAF is completely
    // paused when the tab/window is hidden — which would freeze downloads.
    await new Promise<void>((r) => setTimeout(r, 0));

    if (signal.aborted) break;

    const { episode: ep, originalIndex } = entry;
    const fileName = buildEpisodeFileName(ep, originalIndex);

    callbacks.onEpisodeStart?.(ep.url!);

    const success = await downloadAndImportMedia(
      {
        url: ep.url!,
        fileName,
        projectId,
        thumbnailDataUrl: ep.thumbnail,
        onlineDuration: ep.duration,
        onProgress: callbacks.onProgress,
        episodeIndex: i,
        totalEpisodes: episodes.length,
      },
      signal,
    );

    callbacks.onEpisodeComplete?.(ep.url!, success);
    if (success) importedCount++;
  }

  currentAbortController = null;
  return importedCount;
}

// ─── Format helpers (re-exported for UI components) ──────────────────────────

/** Format bytes into human-readable string */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/** Format download speed */
export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1048576) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
}
