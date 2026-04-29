/**
 * Media Download Worker
 *
 * Handles file downloading entirely off the main thread.
 * Supports streaming progress and zero-copy transfer of results.
 */

export interface DownloadRequest {
  type: 'download'
  id: string
  url: string
}

export interface DownloadProgressMsg {
  type: 'progress'
  id: string
  downloaded: number
  total: number
}

export interface DownloadCompleteMsg {
  type: 'complete'
  id: string
  buffer: ArrayBuffer
  contentType: string
  totalBytes: number
}

export interface DownloadErrorMsg {
  type: 'error'
  id: string
  error: string
}

export type DownloadWorkerResponse = DownloadProgressMsg | DownloadCompleteMsg | DownloadErrorMsg

self.onmessage = async (e: MessageEvent<DownloadRequest>) => {
  const { id, url } = e.data

  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10)
    const contentType = response.headers.get('content-type') || ''

    if (response.body && contentLength > 0) {
      // Streaming download with progress
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let downloaded = 0
      let lastProgressTime = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        chunks.push(value)
        downloaded += value.byteLength

        // Throttle progress to ~4/sec
        const now = Date.now()
        if (now - lastProgressTime >= 250 || downloaded >= contentLength) {
          lastProgressTime = now
          self.postMessage({
            type: 'progress',
            id,
            downloaded,
            total: contentLength,
          } satisfies DownloadProgressMsg)
        }
      }

      // Combine chunks into single ArrayBuffer
      const buffer = new ArrayBuffer(downloaded)
      const view = new Uint8Array(buffer)
      let offset = 0
      for (const chunk of chunks) {
        view.set(chunk, offset)
        offset += chunk.byteLength
      }

      // Transfer (zero-copy) the buffer back to main thread
      const msg: DownloadCompleteMsg = {
        type: 'complete',
        id,
        buffer,
        contentType,
        totalBytes: downloaded,
      }
      ;(
        self as unknown as { postMessage(msg: unknown, transfer: Transferable[]): void }
      ).postMessage(msg, [buffer])
    } else {
      // No content-length — use blob fallback
      const blob = await response.blob()
      const buffer = await blob.arrayBuffer()

      const msg: DownloadCompleteMsg = {
        type: 'complete',
        id,
        buffer,
        contentType: blob.type || contentType,
        totalBytes: buffer.byteLength,
      }
      ;(
        self as unknown as { postMessage(msg: unknown, transfer: Transferable[]): void }
      ).postMessage(msg, [buffer])
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies DownloadErrorMsg)
  }
}
