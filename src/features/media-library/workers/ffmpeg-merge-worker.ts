/**
 * FFmpeg Merge Worker — runs the entire FFmpeg merge pipeline off the main thread.
 *
 * Receives Blob data via MessagePort, performs normalization + concat inside
 * the worker, and returns the merged MP4 as an ArrayBuffer (transferred, not copied).
 *
 * This prevents main-thread lag from:
 *  - Blob→Uint8Array conversion (fetchFile)
 *  - FFmpeg virtual FS read/write serialization
 *  - Large output ArrayBuffer copy
 *
 * Optimizations over previous version:
 *  - FFmpeg core loaded from same origin (/public/ffmpeg/) → no CDN download
 *  - Smart normalization: skipped when all files are codec-compatible (instant merge)
 *  - Preload support: FFmpeg can be loaded before merge starts
 */
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'

export interface MergeWorkerFileInfo {
  blob: Blob
  name: string
  /** Video codec (e.g. 'h264', 'vp9') — from MediaMetadata */
  videoCodec?: string
  /** Audio codec (e.g. 'aac', 'opus') — from MediaMetadata */
  audioCodec?: string
  /** MIME type (e.g. 'video/mp4', 'video/webm') */
  mimeType?: string
}

export interface MergeWorkerRequest {
  type: 'merge' | 'preload'
  files?: MergeWorkerFileInfo[]
}

export interface MergeWorkerProgress {
  kind: 'progress'
  status: 'loading' | 'normalizing' | 'merging' | 'done' | 'error'
  text: string
  progress: number
  currentFile?: number
  totalFiles?: number
}

export interface MergeWorkerResult {
  kind: 'result'
  success: boolean
  /** Transferred ArrayBuffer — only present on success */
  buffer?: ArrayBuffer
  error?: string
}

export type MergeWorkerResponse = MergeWorkerProgress | MergeWorkerResult

let ffmpeg: FFmpeg | null = null
let isLoaded = false

function sendProgress(
  port: MessagePort,
  status: MergeWorkerProgress['status'],
  text: string,
  progress: number,
  extra?: Partial<MergeWorkerProgress>,
): void {
  port.postMessage({
    kind: 'progress',
    status,
    text,
    progress,
    ...extra,
  } satisfies MergeWorkerProgress)
}

/**
 * Determine if all files can be merged without normalization.
 *
 * When all videos share the same container format + compatible codecs,
 * we can skip the expensive normalization step and concat directly.
 * This makes merge nearly instant for batches of downloaded episodes.
 */
function canSkipNormalization(files: MergeWorkerFileInfo[]): boolean {
  if (files.length < 2) return true

  const first = files[0]!
  // Need codec info to make a decision
  if (!first.videoCodec || !first.mimeType) return false

  const refVideoCodec = first.videoCodec.toLowerCase()
  const refAudioCodec = first.audioCodec?.toLowerCase() || ''
  const refMimeType = first.mimeType.toLowerCase()

  // All files must be the same container + codec
  for (let i = 1; i < files.length; i++) {
    const f = files[i]!
    if (!f.videoCodec || !f.mimeType) return false

    if (f.videoCodec.toLowerCase() !== refVideoCodec) return false
    if (f.mimeType.toLowerCase() !== refMimeType) return false

    // Audio codec must match (or both absent)
    const audioCodec = f.audioCodec?.toLowerCase() || ''
    if (audioCodec !== refAudioCodec) return false
  }

  // Only MP4 container supports concat demuxer with -c copy reliably
  if (!refMimeType.includes('mp4')) return false

  return true
}

async function loadFFmpeg(port: MessagePort): Promise<FFmpeg> {
  if (isLoaded && ffmpeg) return ffmpeg

  sendProgress(port, 'loading', 'Memuat FFmpeg engine…', 0)

  ffmpeg = new FFmpeg()

  // Load from same origin (public/ffmpeg/) via toBlobURL — fetched over HTTP
  // (fast, cached by browser) then converted to blob URLs for module import.
  // This eliminates the ~3MB CDN download that made first merge slow.
  const baseURL = '/ffmpeg'
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
  })

  isLoaded = true
  sendProgress(port, 'loading', 'FFmpeg engine siap', 5)
  return ffmpeg
}

async function normalizeSegment(ff: FFmpeg, inputName: string, outputName: string): Promise<void> {
  await ff.exec([
    '-i',
    inputName,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-video_track_timescale',
    '90000',
    '-avoid_negative_ts',
    'make_zero',
    '-y',
    outputName,
  ])
}

async function handleMerge(files: MergeWorkerFileInfo[], port: MessagePort): Promise<void> {
  const ff = await loadFFmpeg(port)
  const totalFiles = files.length
  const skipNorm = canSkipNormalization(files)

  // Phase 1: Write files + optional normalization (5–70%)
  const concatNames: string[] = []

  for (let i = 0; i < totalFiles; i++) {
    const file = files[i]!
    const inputName = `input_${i}.mp4`

    const phaseLabel = skipNorm ? 'Memuat' : 'Normalisasi'
    sendProgress(
      port,
      skipNorm ? 'merging' : 'normalizing',
      `${phaseLabel} ${i + 1}/${totalFiles}: ${file.name}`,
      5 + Math.round((i / totalFiles) * 65),
      { currentFile: i + 1, totalFiles },
    )

    // Convert blob to Uint8Array (heavy but off main thread)
    const fileData = await fetchFile(file.blob)
    await ff.writeFile(inputName, fileData)

    if (skipNorm) {
      // Fast path: use input directly, no re-encoding needed
      concatNames.push(inputName)
    } else {
      // Slow path: normalize audio codec + timescale for compatibility
      const normName = `norm_${i}.mp4`
      await normalizeSegment(ff, inputName, normName)
      // Free input memory
      await ff.deleteFile(inputName).catch(() => {})
      concatNames.push(normName)
    }
  }

  // Phase 2: Concat (70–95%)
  sendProgress(port, 'merging', `Menggabungkan ${totalFiles} video…`, 70)

  const listContent = concatNames.map((name) => `file '${name}'`).join('\n')
  await ff.writeFile('list.txt', new TextEncoder().encode(listContent))

  // Throttled progress from FFmpeg's internal progress events
  let lastProgressTime = 0
  const progressHandler = ({ progress }: { progress: number }) => {
    const now = Date.now()
    if (now - lastProgressTime < 250) return // Max 4 updates/sec
    lastProgressTime = now
    const pct = Math.min(Math.round(progress * 100), 99)
    sendProgress(port, 'merging', `Menyatukan… ${pct}%`, 70 + Math.round(pct * 0.25))
  }
  ff.on('progress', progressHandler)

  await ff.exec([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    'list.txt',
    '-c',
    'copy',
    '-reset_timestamps',
    '1',
    '-avoid_negative_ts',
    'make_zero',
    '-movflags',
    '+faststart',
    '-y',
    'merged_output.mp4',
  ])

  ff.off('progress', progressHandler)

  // Phase 3: Read output (95–99%)
  sendProgress(port, 'merging', 'Membaca hasil…', 95)

  const outputData = await ff.readFile('merged_output.mp4')

  // Copy into a clean ArrayBuffer (detach from SharedArrayBuffer backing)
  let outputBuffer: ArrayBuffer
  if (typeof outputData === 'string') {
    outputBuffer = new TextEncoder().encode(outputData).buffer as ArrayBuffer
  } else {
    const copy = new Uint8Array(outputData.length)
    copy.set(outputData)
    outputBuffer = copy.buffer as ArrayBuffer
  }

  // Cleanup virtual FS
  const cleanupFiles = [...concatNames, 'list.txt', 'merged_output.mp4']
  for (const f of cleanupFiles) {
    await ff.deleteFile(f).catch(() => {})
  }

  sendProgress(port, 'done', 'Merge selesai!', 100)

  // Transfer the buffer (zero-copy back to main thread)
  port.postMessage(
    { kind: 'result', success: true, buffer: outputBuffer } satisfies MergeWorkerResult,
    [outputBuffer],
  )
}

/**
 * Message handler — each merge request uses a MessagePort for
 * progress streaming + final result delivery.
 */
self.onmessage = async (event: MessageEvent<MergeWorkerRequest>) => {
  const port = event.ports[0]
  if (!port) return

  const { type, files } = event.data

  // Preload: just load FFmpeg engine so it's ready when merge is needed
  if (type === 'preload') {
    try {
      await loadFFmpeg(port)
      port.postMessage({
        kind: 'result',
        success: true,
      } satisfies MergeWorkerResult)
    } catch (error) {
      port.postMessage({
        kind: 'result',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies MergeWorkerResult)
    }
    return
  }

  if (type !== 'merge' || !files) {
    port.postMessage({
      kind: 'result',
      success: false,
      error: `Unknown message type: ${type}`,
    } satisfies MergeWorkerResult)
    return
  }

  try {
    await handleMerge(files, port)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendProgress(port, 'error', `Error: ${message}`, 0)
    port.postMessage({
      kind: 'result',
      success: false,
      error: message,
    } satisfies MergeWorkerResult)
  }
}

export {}
