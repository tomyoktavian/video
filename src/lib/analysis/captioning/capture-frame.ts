import { seekVideo } from '../scene-detection-utils'

const MAX_DIM = 512

/**
 * Seek a video element to `timeSec` and capture the current frame as a JPEG
 * blob downscaled to fit within MAX_DIM × MAX_DIM (preserving aspect ratio,
 * 0.8 quality). Used by both the local LFM captioner and the Custom AI
 * vision provider so that prompt-context image bytes are identical regardless
 * of provider.
 */
export async function captureFrame(video: HTMLVideoElement, timeSec: number): Promise<Blob> {
  await seekVideo(video, timeSec)

  const vw = video.videoWidth || 640
  const vh = video.videoHeight || 360
  const scale = Math.min(MAX_DIM / Math.max(vw, vh), 1)
  const width = Math.round(vw * scale)
  const height = Math.round(vh * scale)

  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not acquire captioning canvas context')
  }

  context.drawImage(video, 0, 0, width, height)
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
}
