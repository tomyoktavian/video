import { useCallback, useEffect, useState } from 'react'
import { Loader2, Square } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useEditorStore } from '@/app/state/editor'
import { usePlaybackStore } from '@/shared/state/playback'
import { useCustomAiStore } from '@/features/media-library/deps/settings-contract'
import { cn } from '@/shared/ui/cn'

export type AnalyzeDialogProvider = 'local' | 'custom'

export interface AnalyzeDialogValues {
  provider: AnalyzeDialogProvider
}

interface AnalyzeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * File name shown in the header. For batch (multiple selected media) the
   * caller should pass a synthesized label like "5 media files".
   */
  fileName: string
  hasCaptions: boolean
  isRunning: boolean
  progressPercent: number | null
  progressLabel: string
  errorMessage?: string | null
  onStart: (values: AnalyzeDialogValues) => void
  onCancel: () => void
}

export function AnalyzeDialog({
  open,
  onOpenChange,
  fileName,
  hasCaptions,
  isRunning,
  progressPercent,
  progressLabel,
  errorMessage,
  onStart,
  onCancel,
}: AnalyzeDialogProps) {
  const visionAnalyzer = useCustomAiStore((s) => s.visionAnalyzer)
  const clearMediaSkimPreview = useEditorStore((s) => s.clearMediaSkimPreview)
  const clearCompoundClipSkimPreview = useEditorStore((s) => s.clearCompoundClipSkimPreview)
  const beginTranscriptionDialog = useEditorStore((s) => s.beginTranscriptionDialog)
  const endTranscriptionDialog = useEditorStore((s) => s.endTranscriptionDialog)

  const [provider, setProvider] = useState<AnalyzeDialogProvider>('local')

  useEffect(() => {
    if (!open) return
    setProvider('local')
  }, [open])

  useEffect(() => {
    if (!open) return
    beginTranscriptionDialog()
    clearMediaSkimPreview()
    clearCompoundClipSkimPreview()
    usePlaybackStore.getState().setPreviewFrame(null)
    usePlaybackStore.getState().pause()

    return () => {
      endTranscriptionDialog()
    }
  }, [
    beginTranscriptionDialog,
    clearCompoundClipSkimPreview,
    clearMediaSkimPreview,
    endTranscriptionDialog,
    open,
  ])

  const customConfigured = Boolean(
    visionAnalyzer.baseUrl && visionAnalyzer.apiKey && visionAnalyzer.model,
  )

  const handleStart = () => {
    onStart({ provider })
  }

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (isRunning && !nextOpen) return
      onOpenChange(nextOpen)
    },
    [isRunning, onOpenChange],
  )

  const title = hasCaptions ? 'Re-analyze with AI' : 'Analyze with AI'
  const startLabel = hasCaptions ? 'Re-analyze' : 'Analyze'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} modal>
      <DialogContent
        className="sm:max-w-md"
        hideCloseButton={isRunning}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (isRunning) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="truncate">{fileName}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center rounded-md border border-border bg-secondary p-0.5">
            {(['local', 'custom'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setProvider(value)}
                disabled={isRunning}
                className={cn(
                  'flex-1 rounded px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
                  provider === value
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {value === 'local' ? 'Local AI' : 'Custom AI'}
              </button>
            ))}
          </div>

          {provider === 'local' ? (
            <p className="text-xs text-muted-foreground">
              Captions are generated locally on WebGPU using <strong>LFM 2.5 VL</strong>. Sample
              interval is configured under Settings → AI → Local AI.
            </p>
          ) : customConfigured ? (
            <p className="text-xs text-muted-foreground">
              Using model{' '}
              <span className="font-medium text-foreground">{visionAnalyzer.model}</span> via{' '}
              {visionAnalyzer.baseUrl}.
            </p>
          ) : (
            <p
              role="alert"
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
            >
              Configure base URL, API key, and model in Settings → AI → Custom AI → Vision Analyzer
              before running.
            </p>
          )}

          {errorMessage && !isRunning && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {errorMessage}
            </div>
          )}

          {isRunning && (
            <div className="space-y-1.5 rounded-md border border-border bg-secondary/40 px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span className="truncate">{progressLabel}</span>
              </div>
              {progressPercent !== null && (
                <div
                  role="progressbar"
                  aria-label="Analysis progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progressPercent}
                  className="h-1 overflow-hidden rounded-full bg-secondary"
                >
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {isRunning ? (
            <Button variant="destructive" onClick={onCancel}>
              <Square className="mr-1.5 h-3.5 w-3.5" />
              Stop
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleStart} disabled={provider === 'custom' && !customConfigured}>
                {startLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
