import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Slider } from '@/components/ui/slider'
import { cn } from '@/shared/ui/cn'

import {
  generateFilmstripFramesStreaming,
  renderCoverFrame,
  type FilmstripFrame,
} from '../frame-extraction'
import { useCompositionsStore } from '../deps/timeline'

interface FramePickerProps {
  compositionId: string
  selectedFrame: number
  onChange: (frame: number) => void
}

const FILMSTRIP_THUMB_COUNT = 14

function closeBitmaps(frames: readonly FilmstripFrame[]) {
  for (const f of frames) {
    try {
      f.bitmap.close()
    } catch {
      // already closed
    }
  }
}

function FilmstripThumbnail({ bitmap }: { bitmap: ImageBitmap }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('bitmaprenderer')
    if (ctx) {
      // `transferFromImageBitmap` consumes the bitmap. Clone first so the
      // parent component still owns the original for cleanup.
      void createImageBitmap(bitmap).then((clone) => {
        if (!canvasRef.current) {
          clone.close()
          return
        }
        ctx.transferFromImageBitmap(clone)
      })
      return
    }
    // Fallback for browsers without bitmaprenderer.
    const ctx2d = canvas.getContext('2d')
    if (ctx2d) {
      ctx2d.drawImage(bitmap, 0, 0)
    }
  }, [bitmap])

  return <canvas ref={canvasRef} className="h-full w-auto" />
}

function PreviewCanvas({ bitmap }: { bitmap: ImageBitmap | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !bitmap) return
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('bitmaprenderer')
    if (ctx) {
      void createImageBitmap(bitmap).then((clone) => {
        if (!canvasRef.current) {
          clone.close()
          return
        }
        ctx.transferFromImageBitmap(clone)
      })
      return
    }
    const ctx2d = canvas.getContext('2d')
    if (ctx2d) {
      ctx2d.drawImage(bitmap, 0, 0)
    }
  }, [bitmap])

  if (!bitmap) return null
  return <canvas ref={canvasRef} className="h-full w-full object-contain" />
}

export function FramePicker({ compositionId, selectedFrame, onChange }: FramePickerProps) {
  const composition = useCompositionsStore((s) => s.compositionById[compositionId])

  const [filmstrip, setFilmstrip] = useState<readonly FilmstripFrame[]>([])
  const [filmstripLoading, setFilmstripLoading] = useState(false)
  const [filmstripError, setFilmstripError] = useState<string | null>(null)

  const [previewBitmap, setPreviewBitmap] = useState<ImageBitmap | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewBitmapRef = useRef<ImageBitmap | null>(null)
  const previewSeqRef = useRef(0)

  // Filmstrip generation — once per compositionId. Frames stream in
  // progressively as the worker finishes them.
  useEffect(() => {
    let cancelled = false
    const collected: FilmstripFrame[] = []

    setFilmstrip([])
    setFilmstripLoading(true)
    setFilmstripError(null)

    const handle = generateFilmstripFramesStreaming(
      compositionId,
      FILMSTRIP_THUMB_COUNT,
      (frame) => {
        if (cancelled) {
          frame.bitmap.close()
          return
        }
        collected.push(frame)
        // Sort by frame number so the strip stays left-to-right even if
        // frames arrive out of order (they shouldn't, but be defensive).
        const sorted = [...collected].sort((a, b) => a.frame - b.frame)
        setFilmstrip(sorted)
      },
    )

    handle.promise
      .then(() => {
        if (!cancelled) setFilmstripLoading(false)
      })
      .catch((error) => {
        if (cancelled) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        setFilmstripError(error instanceof Error ? error.message : 'Failed to load filmstrip')
        setFilmstripLoading(false)
      })

    return () => {
      cancelled = true
      handle.cancel()
      closeBitmaps(collected)
      setFilmstrip([])
    }
  }, [compositionId])

  // Preview generation — debounced as the user scrubs.
  useEffect(() => {
    const seq = ++previewSeqRef.current
    setPreviewLoading(true)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const blob = await renderCoverFrame(compositionId, selectedFrame, { width: 720 })
          if (seq !== previewSeqRef.current) return
          const bitmap = await createImageBitmap(blob)
          if (seq !== previewSeqRef.current) {
            bitmap.close()
            return
          }
          if (previewBitmapRef.current) previewBitmapRef.current.close()
          previewBitmapRef.current = bitmap
          setPreviewBitmap(bitmap)
        } catch {
          if (seq === previewSeqRef.current) {
            if (previewBitmapRef.current) {
              previewBitmapRef.current.close()
              previewBitmapRef.current = null
            }
            setPreviewBitmap(null)
          }
        } finally {
          if (seq === previewSeqRef.current) setPreviewLoading(false)
        }
      })()
    }, 120)

    return () => {
      clearTimeout(timer)
    }
  }, [compositionId, selectedFrame])

  // Final cleanup on unmount.
  useEffect(() => {
    return () => {
      if (previewBitmapRef.current) {
        previewBitmapRef.current.close()
        previewBitmapRef.current = null
      }
    }
  }, [])

  const duration = composition?.durationInFrames ?? 0
  const maxFrame = Math.max(0, duration - 1)

  return (
    <div className="space-y-2">
      <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border bg-black">
        {previewBitmap ? (
          <PreviewCanvas bitmap={previewBitmap} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {previewLoading ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-4 w-4 animate-spin" />
                Rendering frame…
              </span>
            ) : (
              'Frame preview unavailable'
            )}
          </div>
        )}
        {previewLoading && previewBitmap ? (
          <div className="absolute right-2 top-2 rounded-md bg-black/60 p-1">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-white" />
          </div>
        ) : null}
      </div>

      <Slider
        min={0}
        max={maxFrame}
        step={1}
        value={[Math.min(selectedFrame, maxFrame)]}
        onValueChange={(values) => {
          const next = values[0]
          if (typeof next === 'number') onChange(Math.max(0, Math.min(maxFrame, Math.round(next))))
        }}
        aria-label="Cover frame position"
      />

      <div className="rounded-md border border-border bg-secondary/30 p-1.5">
        {filmstripError ? (
          <p className="px-2 py-1 text-xs text-destructive">{filmstripError}</p>
        ) : filmstripLoading && filmstrip.length === 0 ? (
          <div className="flex h-12 items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading thumbnails…
          </div>
        ) : (
          <div className="flex gap-1 overflow-x-auto">
            {filmstrip.map((frame) => {
              const isActive = Math.abs(frame.frame - selectedFrame) < 2
              return (
                <button
                  key={frame.frame}
                  type="button"
                  onClick={() => onChange(frame.frame)}
                  className={cn(
                    'h-12 shrink-0 overflow-hidden rounded border-2 transition',
                    isActive ? 'border-primary' : 'border-transparent opacity-70 hover:opacity-100',
                  )}
                  aria-label={`Use frame ${frame.frame}`}
                >
                  <FilmstripThumbnail bitmap={frame.bitmap} />
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
