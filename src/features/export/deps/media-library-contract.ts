/**
 * Adapter exports for media-library dependencies.
 * Export modules should import media resolution helpers from here.
 */

import { useMediaLibraryStore } from "@/features/media-library/stores/media-library-store";

export {
  resolveMediaUrl,
  resolveMediaUrls,
  resolveProxyUrl,
  cleanupBlobUrls,
} from "@/features/media-library/utils/media-resolver";

export function getMaxSourceVideoBitrate(
  items: Array<{ type: string; mediaId?: string }>,
): number {
  const mediaById = useMediaLibraryStore.getState().mediaById;
  let maxBitrate = 0;

  for (const item of items) {
    if (item.type !== "video" || !item.mediaId) continue;
    const media = mediaById[item.mediaId];
    if (!media) continue;

    const bitrate =
      media.bitrate > 0
        ? media.bitrate
        : media.duration > 0
          ? (media.fileSize * 8) / media.duration
          : 0;

    if (bitrate > maxBitrate) {
      maxBitrate = bitrate;
    }
  }

  return maxBitrate;
}

export function getMediaAudioCodecById(
  mediaId: string | undefined,
): string | undefined {
  if (!mediaId) return undefined;

  const media = useMediaLibraryStore.getState().mediaById[mediaId];
  if (!media) return undefined;

  if (media.mimeType.startsWith("video/")) {
    return media.audioCodec;
  }
  if (media.mimeType.startsWith("audio/")) {
    return media.codec;
  }
  return undefined;
}
