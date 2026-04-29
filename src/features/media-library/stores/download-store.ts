/**
 * Download Store
 *
 * Persistent Zustand store for online media downloads.
 * Lives outside React component lifecycle — downloads continue
 * even when the user navigates away from OnlineMediaTab.
 */

import { create } from "zustand";
import {
  downloadAndImportMedia,
  downloadAllMedia,
  cancelAllDownloads,
  buildEpisodeFileName,
  type DownloadProgress,
} from "../utils/download-utils";
import type { OnlineEpisode, FetchStatus } from "../components/media-card";

interface DownloadStore {
  /** Whether any download is in progress */
  isDownloading: boolean;
  /** Current download progress (IDM-style) */
  downloadProgress: DownloadProgress | null;
  /** URLs currently being downloaded */
  downloadingUrls: Set<string>;
  /** URLs that have been successfully downloaded */
  downloadedUrls: Set<string>;

  /** Persistent online episodes after parsing JSON */
  onlineEpisodes: OnlineEpisode[];
  /** Persistent fetch statuses for metadata extraction */
  fetchStatuses: Record<number, FetchStatus>;

  // ─── Actions ───────────────────────────────────────────────────────

  /** Set online episodes */
  setOnlineEpisodes: (
    episodes:
      | OnlineEpisode[]
      | ((prev: OnlineEpisode[]) => OnlineEpisode[]),
  ) => void;
  /** Set fetch statuses */
  setFetchStatuses: (
    statuses:
      | Record<number, FetchStatus>
      | ((prev: Record<number, FetchStatus>) => Record<number, FetchStatus>),
  ) => void;
  /** Update a single episode's metadata */
  updateEpisodeMetadata: (
    index: number,
    metadata: { duration: number; thumbnail: string },
  ) => void;

  /** Mark a URL as downloaded */
  markDownloaded: (url: string) => void;
  /** Sync multiple URLs as downloaded (e.g. from existing media library) */
  syncDownloaded: (urls: string[]) => void;
  /** Reset downloaded tracking */
  resetDownloaded: () => void;

  /** Download a single episode */
  startSingleDownload: (
    ep: OnlineEpisode,
    originalIndex: number,
    projectId: string,
    callbacks?: {
      onSuccess?: () => void;
      onError?: (error: string) => void;
    },
  ) => Promise<boolean>;

  /** Download all pending episodes */
  startBulkDownload: (
    episodes: Array<{ episode: OnlineEpisode; originalIndex: number }>,
    projectId: string,
    callbacks?: {
      onAllComplete?: (importedCount: number) => void;
    },
  ) => Promise<number>;

  /** Cancel all active downloads */
  cancelDownload: () => void;
}

export const useDownloadStore = create<DownloadStore>()((set, get) => ({
  isDownloading: false,
  downloadProgress: null,
  downloadingUrls: new Set(),
  downloadedUrls: new Set(),
  onlineEpisodes: [],
  fetchStatuses: {},

  setOnlineEpisodes: (episodes) =>
    set((s) => ({
      onlineEpisodes:
        typeof episodes === "function" ? episodes(s.onlineEpisodes) : episodes,
    })),

  setFetchStatuses: (statuses) =>
    set((s) => ({
      fetchStatuses:
        typeof statuses === "function" ? statuses(s.fetchStatuses) : statuses,
    })),

  updateEpisodeMetadata: (index, metadata) =>
    set((s) => {
      const next = [...s.onlineEpisodes];
      const originalIdx = next.findIndex((e) => e.originalIndex === index);
      if (originalIdx !== -1) {
        next[originalIdx] = {
          ...next[originalIdx],
          duration: metadata.duration,
          thumbnail: metadata.thumbnail,
        };
      }
      return { onlineEpisodes: next };
    }),

  markDownloaded: (url) =>
    set((s) => ({
      downloadedUrls: new Set([...s.downloadedUrls, url]),
    })),

  syncDownloaded: (urls) =>
    set((s) => {
      const merged = new Set([...s.downloadedUrls, ...urls]);
      if (merged.size === s.downloadedUrls.size) return s;
      return { downloadedUrls: merged };
    }),

  resetDownloaded: () => set({ downloadedUrls: new Set() }),

  startSingleDownload: async (ep, originalIndex, projectId, callbacks) => {
    if (!ep.url || get().isDownloading) return false;

    const url = ep.url;
    const fileName = buildEpisodeFileName(ep, originalIndex);

    set((s) => ({
      isDownloading: true,
      downloadingUrls: new Set([...s.downloadingUrls, url]),
    }));

    try {
      const success = await downloadAndImportMedia({
        url,
        fileName,
        projectId,
        thumbnailDataUrl: ep.thumbnail,
        onlineDuration: ep.duration,
        onProgress: (progress) => set({ downloadProgress: progress }),
        episodeIndex: 0,
        totalEpisodes: 1,
      });

      if (success) {
        set((s) => ({
          downloadedUrls: new Set([...s.downloadedUrls, url]),
        }));
        callbacks?.onSuccess?.();
      }

      return success;
    } catch (error) {
      callbacks?.onError?.(
        error instanceof Error ? error.message : String(error),
      );
      return false;
    } finally {
      set((s) => {
        const next = new Set(s.downloadingUrls);
        next.delete(url);
        return {
          isDownloading: false,
          downloadingUrls: next,
          downloadProgress: null,
        };
      });
    }
  },

  startBulkDownload: async (episodes, projectId, callbacks) => {
    if (get().isDownloading) return 0;

    set({ isDownloading: true });

    try {
      const count = await downloadAllMedia(episodes, projectId, {
        onProgress: (progress) => set({ downloadProgress: progress }),
        onEpisodeStart: (url) => {
          set((s) => ({
            downloadingUrls: new Set([...s.downloadingUrls, url]),
          }));
        },
        onEpisodeComplete: (url, success) => {
          set((s) => {
            const nextDownloading = new Set(s.downloadingUrls);
            nextDownloading.delete(url);
            const nextDownloaded = success
              ? new Set([...s.downloadedUrls, url])
              : s.downloadedUrls;
            return {
              downloadingUrls: nextDownloading,
              downloadedUrls: nextDownloaded,
            };
          });
        },
      });

      callbacks?.onAllComplete?.(count);
      return count;
    } finally {
      set({
        isDownloading: false,
        downloadProgress: null,
        downloadingUrls: new Set(),
      });
    }
  },

  cancelDownload: () => {
    cancelAllDownloads();
    set({
      isDownloading: false,
      downloadProgress: null,
      downloadingUrls: new Set(),
    });
  },
}));
