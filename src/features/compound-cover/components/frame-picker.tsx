import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Slider } from '@/components/ui/slider'
import { cn } from '@/shared/ui/cn'

import {
  generateFilmstripFrames,
  renderCoverFrame,
  revokeFilmstripFrames,
  type FilmstripFrame,
} from '../frame-extraction'
import { useCompositionsStore } from '../deps/timeline'

interface FramePickerProps {
  compositionId: string
  selectedFrame: number
  onChange: (frame: number) => void
}

const FILMSTRIP_THUMB_COUNT = 14

export function FramePicker({ compositionId, selectedFrame, onChange }: FramePickerProps) {
  const composition = useCompositionsStore((s) => s.compositionById[compositionId])

  const [filmstrip, setFilmstrip] = useState<readonly FilmstripFrame[]>([])
  const [filmstripLoading, setFilmstripLoading] = useState(false)
  const [filmstripError, setFilmstripError] = useState<string | null>(null)

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewUrlRef = useRef<string | null>(null)
  const previewSeqRef = useRef(0)

  // Filmstrip generation — once per compositionId.
  useEffect(() => {
    let cancelled = false
    let frames: FilmstripFrame[] = []

    const run = async () => {
      setFilmstripLoading(true)
      setFilmstripError(null)
      try {
        frames = await generateFilmstripFrames(compositionId, FILMSTRIP_THUMB_COUNT)
        if (cancelled) {
          revokeFilmstripFrames(frames)
          return
        }
        setFilmstrip(frames)
      } catch (error) {
        if (cancelled) return
        setFilmstripError(error instanceof Error ? error.message : 'Failed to load filmstrip')
      } finally {
        if (!cancelled) setFilmstripLoading(false)
      }
    }

    void run()
    return () => {
      cancelled = true
      revokeFilmstripFrames(frames)
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
          const url = URL.createObjectURL(blob)
          if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
          previewUrlRef.current = url
          setPreviewUrl(url)
        } catch {
          if (seq === previewSeqRef.current) setPreviewUrl(null)
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
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = null
      }
    }
  }, [])

  const duration = composition?.durationInFrames ?? 0
  const maxFrame = Math.max(0, duration - 1)

  return (
    <div className="space-y-2">
      <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border bg-black">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt="Cover frame preview"
            className="h-full w-full object-contain"
          />
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
        {previewLoading && previewUrl ? (
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
                  <img src={frame.blobUrl} alt="" className="h-full w-auto" draggable={false} />
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
