import { useEffect, useMemo, useState } from 'react'
import { Eye, FolderArchive, Layers, Video } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/shared/ui/cn'
import { framesToSeconds, formatDuration } from '@/shared/utils/time-utils'
import {
  useCompositionsStore,
  useCompositionNavigationStore,
  type SubComposition,
} from '@/features/editor/deps/timeline-store'
import { compoundClipThumbnailService } from '@/features/editor/deps/media-library'

export type ExportLauncherFormat = 'video' | 'zip'
export type ExportLauncherScope = 'timeline' | 'composition'

export interface ExportLauncherSelection {
  format: ExportLauncherFormat
  /** Set when scope === 'composition'. */
  compositionId: string | null
}

export interface ExportLauncherDialogProps {
  open: boolean
  onClose: () => void
  onSelect: (selection: ExportLauncherSelection) => void
}

export function ExportLauncherDialog({ open, onClose, onSelect }: ExportLauncherDialogProps) {
  const compositions = useCompositionsStore((s) => s.compositions)
  const activeCompositionId = useCompositionNavigationStore((s) => s.activeCompositionId)
  const enterComposition = useCompositionNavigationStore((s) => s.enterComposition)

  const defaultCompositionId = useMemo(() => {
    if (compositions.length === 0) return null
    if (activeCompositionId && compositions.some((c) => c.id === activeCompositionId)) {
      return activeCompositionId
    }
    return compositions[0]?.id ?? null
  }, [compositions, activeCompositionId])

  const [format, setFormat] = useState<ExportLauncherFormat>('video')
  const [scope, setScope] = useState<ExportLauncherScope>('composition')
  const [selectedCompositionId, setSelectedCompositionId] = useState<string | null>(
    defaultCompositionId,
  )

  // Re-seed defaults each time the dialog opens.
  useEffect(() => {
    if (open) {
      setFormat('video')
      setScope(defaultCompositionId ? 'composition' : 'timeline')
      setSelectedCompositionId(defaultCompositionId)
    }
  }, [open, defaultCompositionId])

  const handleOpenChange = (next: boolean) => {
    if (!next) onClose()
  }

  const canContinue = scope === 'timeline' || Boolean(selectedCompositionId)

  const handleContinue = () => {
    if (!canContinue) return
    onSelect({
      format,
      compositionId: scope === 'composition' ? selectedCompositionId : null,
    })
  }

  const handlePreview = (composition: SubComposition) => {
    // Navigate the editor into this compound so the user can play/scrub it
    // with the main preview engine. enterComposition is a no-op when this
    // compound is already the active one — in that case we just close.
    if (composition.id !== activeCompositionId) {
      enterComposition(composition.id, composition.name)
    }
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>
            Choose a format and what to export from this project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Format</div>
            <div className="flex items-center rounded-md border border-border bg-secondary p-0.5">
              <SegmentedButton
                active={format === 'video'}
                onClick={() => setFormat('video')}
                icon={<Video className="h-3.5 w-3.5" />}
                label="Video"
              />
              <SegmentedButton
                active={format === 'zip'}
                onClick={() => setFormat('zip')}
                icon={<FolderArchive className="h-3.5 w-3.5" />}
                label="Project (.zip)"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Source</div>
            <div className="flex items-center rounded-md border border-border bg-secondary p-0.5">
              <SegmentedButton
                active={scope === 'composition'}
                onClick={() => setScope('composition')}
                icon={<Layers className="h-3.5 w-3.5" />}
                label="Compound clip"
              />
              <SegmentedButton
                active={scope === 'timeline'}
                onClick={() => setScope('timeline')}
                icon={<Video className="h-3.5 w-3.5" />}
                label="Full timeline"
              />
            </div>
            {scope === 'timeline' && (
              <p className="text-xs text-muted-foreground">
                Exports the main timeline as today — same behavior as the legacy buttons.
              </p>
            )}
          </div>

          {scope === 'composition' && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Compound clip</div>
              {compositions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This project has no compound clips. Switch to &ldquo;Full timeline&rdquo; above.
                </p>
              ) : (
                <div className="grid max-h-[320px] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3">
                  {compositions.map((composition) => (
                    <CompositionCard
                      key={composition.id}
                      composition={composition}
                      selected={composition.id === selectedCompositionId}
                      onSelect={() => setSelectedCompositionId(composition.id)}
                      onPreview={() => handlePreview(composition)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleContinue} disabled={!canContinue}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface SegmentedButtonProps {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}

function SegmentedButton({ active, onClick, icon, label }: SegmentedButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition-colors',
        active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

interface CompositionCardProps {
  composition: SubComposition
  selected: boolean
  onSelect: () => void
  onPreview: () => void
}

function CompositionCard({ composition, selected, onSelect, onPreview }: CompositionCardProps) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void compoundClipThumbnailService.getThumbnailBlobUrl(composition.id).then((url) => {
      if (!cancelled) setThumbnailUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [composition.id])

  const durationLabel = formatDuration(
    framesToSeconds(composition.durationInFrames, composition.fps),
  )

  return (
    <div
      className={cn(
        'group relative flex flex-col gap-2 rounded-lg border-2 p-2 transition-colors',
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border bg-secondary/30 hover:border-primary/50',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex flex-col gap-2 text-left"
      >
        <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border bg-black">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={composition.name}
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">
              <Layers className="h-4 w-4" />
            </div>
          )}
        </div>
        <div>
          <div className="text-sm font-medium wrap-break-word">{composition.name}</div>
          <div className="font-mono text-[11px] text-muted-foreground">
            {composition.width}×{composition.height} · {durationLabel}
          </div>
        </div>
      </button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 text-xs"
        onClick={(e) => {
          e.stopPropagation()
          onPreview()
        }}
      >
        <Eye className="h-3.5 w-3.5" />
        Preview
      </Button>
    </div>
  )
}
