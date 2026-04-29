import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { RotateCcw, CloudDownload, Loader2, X } from "lucide-react";
import { createLogger } from "@/shared/logging/logger";
import { Button } from "@/components/ui/button";
import { useMediaLibraryStore } from "../stores/media-library-store";
import { useDownloadStore } from "../stores/download-store";
import { GRID_MIN_SIZE_PX, GRID_GAP_BY_SIZE } from "./media-grid-constants";
import { MediaCard, type OnlineEpisode, type FetchStatus } from "./media-card";
import { useEditorStore } from "@/app/state/editor";
import { formatBytes, formatSpeed } from "../utils/download-utils";

const logger = createLogger("OnlineMediaTab");

async function extractVideoMetadata(
  url: string,
): Promise<{ duration: number; thumbnail: string }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.src = url;
    video.muted = true;
    video.playsInline = true;

    let seeked = false;

    video.onloadeddata = () => {
      const seekTime = Math.min(1, video.duration / 2);
      video.currentTime = seekTime || 0.1;
    };

    video.onseeked = () => {
      if (seeked) return;
      seeked = true;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 360;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const thumbnail = canvas.toDataURL("image/jpeg", 0.7);
          resolve({ duration: video.duration, thumbnail });
        } else {
          reject(new Error("Failed to get canvas context"));
        }
      } catch (err) {
        reject(err);
      } finally {
        video.src = "";
      }
    };

    video.onerror = () => {
      reject(new Error("Failed to load video"));
    };

    setTimeout(() => reject(new Error("Timeout fetching metadata")), 15000);
  });
}

interface OnlineMediaTabProps {
  viewMode: "grid" | "list";
  itemSize: number;
  sortBy: "name" | "date" | "size";
  filterByType: string | null;
  onSwitchToLocal?: () => void;
}

export function OnlineMediaTab({
  viewMode,
  itemSize,
  sortBy,
  filterByType,
  onSwitchToLocal,
}: OnlineMediaTabProps) {
  const [jsonInput, setJsonInput] = useState(
    () => localStorage.getItem("freecut_online_json") || "",
  );
  
  // ─── Persistent online state from store (survives tab switch) ───
  const onlineEpisodes = useDownloadStore((s) => s.onlineEpisodes);
  const fetchStatuses = useDownloadStore((s) => s.fetchStatuses);
  const setOnlineEpisodes = useDownloadStore((s) => s.setOnlineEpisodes);
  const setFetchStatuses = useDownloadStore((s) => s.setFetchStatuses);
  const updateEpisodeMetadata = useDownloadStore((s) => s.updateEpisodeMetadata);
  
  const currentImportIdRef = useRef(0);

  // ─── Persistent download state from store (survives unmount) ───
  const isDownloading = useDownloadStore((s) => s.isDownloading);
  const downloadProgress = useDownloadStore((s) => s.downloadProgress);
  const downloadingUrls = useDownloadStore((s) => s.downloadingUrls);
  const downloadedUrls = useDownloadStore((s) => s.downloadedUrls);

  const showNotification = useMediaLibraryStore((s) => s.showNotification);
  const currentProjectId = useMediaLibraryStore((s) => s.currentProjectId);
  const refreshMediaList = useMediaLibraryStore((s) => s.loadMediaItems);
  const mediaItems = useMediaLibraryStore((s) => s.mediaItems);

  // Persist JSON to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("freecut_online_json", jsonInput);
    } catch (e) {
      console.error("Failed to save JSON to localStorage", e);
    }
  }, [jsonInput]);

  // Sync downloadedUrls from existing project media's sourceUrl
  useEffect(() => {
    if (onlineEpisodes.length === 0) return;

    const existingSourceUrls: string[] = [];
    for (const m of mediaItems) {
      if (m.sourceUrl) existingSourceUrls.push(m.sourceUrl);
    }
    if (existingSourceUrls.length === 0) return;

    const matchingUrls: string[] = [];
    const sourceSet = new Set(existingSourceUrls);
    for (const ep of onlineEpisodes) {
      if (ep.url && sourceSet.has(ep.url)) {
        matchingUrls.push(ep.url);
      }
    }

    if (matchingUrls.length > 0) {
      useDownloadStore.getState().syncDownloaded(matchingUrls);
    }
  }, [onlineEpisodes, mediaItems]);

  const processMetadataQueue = async (
    episodes: OnlineEpisode[],
    statuses: Record<number, FetchStatus>,
    importId: number,
  ) => {
    for (let i = 0; i < episodes.length; i++) {
      if (currentImportIdRef.current !== importId) break;

      const ep = episodes[i];
      if (!ep || !ep.url) continue;

      if (statuses[i] === "queued") {
        setFetchStatuses((prev) => ({ ...prev, [i]: "fetching" }));
        try {
          const meta = await extractVideoMetadata(ep.url);
          if (currentImportIdRef.current !== importId) break;

          updateEpisodeMetadata(i, meta);
          setFetchStatuses((prev) => ({ ...prev, [i]: "done" }));
        } catch {
          if (currentImportIdRef.current !== importId) break;
          setFetchStatuses((prev) => ({ ...prev, [i]: "error" }));
        }
      }
    }
  };

  const handleImportOnline = () => {
    try {
      const parsed = JSON.parse(jsonInput);
      if (parsed.episodes && Array.isArray(parsed.episodes)) {
        const importId = ++currentImportIdRef.current;
        const initialStatuses: Record<number, FetchStatus> = {};
        const dramaTitle = parsed.name || "";

        const episodesWithIndex = parsed.episodes.map(
          (ep: OnlineEpisode, i: number) => {
            if (!ep.thumbnail || !ep.duration) {
              initialStatuses[i] = "queued";
            } else {
              initialStatuses[i] = "done";
            }
            return { ...ep, dramaTitle, originalIndex: i };
          },
        );

        setFetchStatuses(initialStatuses);
        setOnlineEpisodes(episodesWithIndex);

        processMetadataQueue(episodesWithIndex, initialStatuses, importId);
      } else {
        showNotification({
          type: "warning",
          message: "No episodes found in JSON",
        });
      }
    } catch {
      showNotification({ type: "error", message: "Invalid JSON format" });
    }
  };

  // Sorting
  const sortedEpisodes = useMemo(() => {
    let items = [...onlineEpisodes];

    if (filterByType && filterByType !== "video") {
      items = [];
    }

    items.sort((a, b) => {
      if (sortBy === "name") {
        const nameA = a.dramaTitle || a.url || "";
        const nameB = b.dramaTitle || b.url || "";
        return nameA.localeCompare(nameB);
      } else if (sortBy === "date") {
        const dateA = a.date ? new Date(a.date).getTime() : 0;
        const dateB = b.date ? new Date(b.date).getTime() : 0;
        return dateB - dateA;
      } else if (sortBy === "size") {
        const sizeA = a.size || 0;
        const sizeB = b.size || 0;
        return sizeB - sizeA;
      }
      return 0;
    });

    return items;
  }, [onlineEpisodes, sortBy, filterByType]);

  /** Download a single episode via persistent store */
  const handleSingleDownload = useCallback(
    async (ep: OnlineEpisode, originalIndex: number) => {
      if (!ep.url || !currentProjectId) return;

      const store = useDownloadStore.getState();
      if (store.isDownloading) return;

      const success = await store.startSingleDownload(
        ep,
        originalIndex,
        currentProjectId,
        {
          onSuccess: async () => {
            await refreshMediaList();
            showNotification({
              type: "success",
              message: `Downloaded ${ep.dramaTitle || "episode"}`,
            });
          },
          onError: (err) => {
            showNotification({
              type: "error",
              message: `Download gagal: ${err}`,
            });
          },
        },
      );

      if (!success) {
        logger.warn("Single download returned false for", ep.url);
      }
    },
    [currentProjectId, showNotification, refreshMediaList],
  );

  /** Download all pending episodes via persistent store */
  const handleDownloadAll = useCallback(async () => {
    if (!currentProjectId) {
      showNotification({ type: "error", message: "No project selected" });
      return;
    }

    const store = useDownloadStore.getState();
    if (store.isDownloading) return;

    const pendingEpisodes = sortedEpisodes.filter(
      (ep) => ep.url && !downloadedUrls.has(ep.url),
    );

    if (pendingEpisodes.length === 0) {
      showNotification({
        type: "info",
        message: "All episodes already downloaded",
      });
      return;
    }

    const episodeEntries = pendingEpisodes.map((ep) => ({
      episode: ep,
      originalIndex: ep.originalIndex ?? sortedEpisodes.indexOf(ep),
    }));

    await store.startBulkDownload(episodeEntries, currentProjectId, {
      onAllComplete: async (importedCount) => {
        if (importedCount > 0) {
          await refreshMediaList();
          showNotification({
            type: "success",
            message: `${importedCount} episodes downloaded and imported!`,
          });
          onSwitchToLocal?.();
        } else {
          showNotification({
            type: "info",
            message: "No new episodes to download",
          });
        }
      },
    });
  }, [
    currentProjectId,
    sortedEpisodes,
    downloadedUrls,
    showNotification,
    refreshMediaList,
    onSwitchToLocal,
  ]);

  const setSourcePreviewMediaId = useEditorStore(
    (s) => s.setSourcePreviewMediaId,
  );

  // Download percentage
  const downloadPercent = downloadProgress
    ? downloadProgress.total > 0
      ? Math.round((downloadProgress.downloaded / downloadProgress.total) * 100)
      : 0
    : 0;

  return (
    <div className="flex flex-1 flex-col h-full overflow-hidden p-4">
      {onlineEpisodes.length === 0 ? (
        <div className="flex flex-1 flex-col">
          <div className="mb-2 text-xs text-muted-foreground">
            Import JSON Data
          </div>
          <textarea
            className="flex-1 min-h-[150px] w-full resize-none rounded-md border border-border bg-secondary p-3 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary custom-scrollbar"
            placeholder='{"name": "...", "episodes": []}'
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
          />
          <div className="mt-3 flex justify-end">
            <Button
              onClick={handleImportOnline}
              disabled={!jsonInput.trim()}
              size="sm"
            >
              Parse JSON
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="mb-3 flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>Imported Online Media ({sortedEpisodes.length})</span>
            <button
              onClick={() => {
                setOnlineEpisodes([]);
                setJsonInput("");
                setFetchStatuses({});
                useDownloadStore.getState().resetDownloaded();
                localStorage.removeItem("freecut_online_json");
              }}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-destructive transition-colors hover:bg-destructive/10"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          </div>

          <div className="custom-scrollbar flex-1 overflow-y-auto pr-1">
            <div
              className={
                viewMode === "grid"
                  ? `grid ${GRID_GAP_BY_SIZE[itemSize] ?? GRID_GAP_BY_SIZE[3]}`
                  : "space-y-1"
              }
              style={
                viewMode === "grid"
                  ? {
                      gridTemplateColumns: `repeat(auto-fill, minmax(min(${GRID_MIN_SIZE_PX[itemSize] ?? GRID_MIN_SIZE_PX[3]}px, 100%), 1fr))`,
                    }
                  : undefined
              }
            >
              {sortedEpisodes.map((ep, i) => {
                const originalIndex = ep.originalIndex ?? i;
                const isDownloaded = ep.url
                  ? downloadedUrls.has(ep.url)
                  : false;
                const isDownloading = ep.url
                  ? downloadingUrls.has(ep.url)
                  : false;
                const status = fetchStatuses[originalIndex] ?? "done";

                const progress =
                  isDownloading &&
                  downloadProgress &&
                  downloadProgress.total > 0
                    ? Math.round(
                        (downloadProgress.downloaded / downloadProgress.total) *
                          100,
                      )
                    : null;

                return (
                  <MediaCard
                    key={i}
                    onlineEpisode={ep}
                    onlineIndex={originalIndex}
                    viewMode={viewMode}
                    isOnlineDownloaded={isDownloaded}
                    isOnlineDownloading={isDownloading}
                    onlineDownloadProgress={progress}
                    onlineFetchStatus={status}
                    onDoubleClick={() => {
                      if (status === "done" && ep.url) {
                        setSourcePreviewMediaId(`online:${JSON.stringify(ep)}`);
                      }
                    }}
                    onOnlineDownload={() => {
                      if (
                        !isDownloaded &&
                        status === "done" &&
                        ep.url &&
                        currentProjectId
                      ) {
                        handleSingleDownload(ep, originalIndex);
                      }
                    }}
                    onDelete={() => {
                      setOnlineEpisodes((prev) =>
                        prev.filter((_, idx) => idx !== originalIndex),
                      );
                      const newStatuses = { ...fetchStatuses };
                      delete newStatuses[originalIndex];

                      const shiftedStatuses: Record<number, FetchStatus> = {};
                      Object.keys(newStatuses).forEach((key) => {
                        const numKey = parseInt(key, 10);
                        const val = newStatuses[numKey];
                        if (val) {
                          if (numKey > originalIndex) {
                            shiftedStatuses[numKey - 1] = val;
                          } else {
                            shiftedStatuses[numKey] = val;
                          }
                        }
                      });
                      setFetchStatuses(shiftedStatuses);
                    }}
                  />
                );
              })}
            </div>
          </div>

          {/* Download progress bar (IDM-style) — reads from persistent store */}
          {downloadProgress && (
            <div className="mt-2 rounded-md border border-border bg-secondary/50 px-3 py-2">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Loader2 className="w-3 h-3 text-blue-500 animate-spin shrink-0" />
                  <span className="text-foreground truncate font-medium">
                    {downloadProgress.fileName}
                  </span>
                  <span className="text-muted-foreground shrink-0">
                    ({downloadProgress.episodeIndex + 1}/
                    {downloadProgress.totalEpisodes})
                  </span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground shrink-0 ml-2">
                  {downloadProgress.phase === "downloading" &&
                    downloadProgress.total > 0 && (
                      <>
                        <span className="tabular-nums">
                          {formatBytes(downloadProgress.downloaded)} /{" "}
                          {formatBytes(downloadProgress.total)}
                        </span>
                        <span className="tabular-nums text-blue-400">
                          {formatSpeed(downloadProgress.speed)}
                        </span>
                      </>
                    )}
                  {downloadProgress.phase === "processing" && (
                    <span className="text-amber-400">Processing…</span>
                  )}
                  {downloadProgress.phase === "saving" && (
                    <span className="text-green-400">Saving…</span>
                  )}
                  {/* Cancel button */}
                  <button
                    type="button"
                    onClick={() => {
                      useDownloadStore.getState().cancelDownload();
                      showNotification({
                        type: "info",
                        message: "Download cancelled",
                      });
                    }}
                    className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                    title="Cancel download"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    downloadProgress.phase === "processing"
                      ? "bg-amber-500"
                      : downloadProgress.phase === "saving"
                        ? "bg-green-500"
                        : "bg-blue-500"
                  }`}
                  style={{
                    width: `${downloadProgress.phase === "downloading" ? downloadPercent : 100}%`,
                  }}
                />
              </div>
              {downloadProgress.total > 0 &&
                downloadProgress.phase === "downloading" && (
                  <div className="text-[10px] text-muted-foreground mt-1 text-right tabular-nums">
                    {downloadPercent}%
                  </div>
                )}
            </div>
          )}

          <div className="mt-2 flex justify-end">
            <Button
              onClick={handleDownloadAll}
              disabled={isDownloading || sortedEpisodes.length === 0}
              className="w-full sm:w-auto"
            >
              {isDownloading && downloadProgress ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {downloadProgress.phase === "downloading" &&
                  downloadProgress.total > 0
                    ? `${downloadPercent}% — ${downloadProgress.episodeIndex + 1}/${downloadProgress.totalEpisodes}`
                    : `${downloadProgress.phase === "processing" ? "Processing" : "Downloading"} ${downloadProgress.episodeIndex + 1}/${downloadProgress.totalEpisodes}`}
                </>
              ) : isDownloading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Downloading...
                </>
              ) : (
                <>
                  <CloudDownload className="w-4 h-4 mr-2" />
                  Download All
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
