import { useCallback, useMemo, useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useCustomAiStore } from '@/features/editor/deps/settings-contract'
import { fetchCustomAiModels } from '@/features/editor/deps/media-library-contract'
import { DEFAULT_HIGHLIGHT_FINDER_SYSTEM_PROMPT } from '@/features/editor/deps/highlight-finder'

const PLACEHOLDER_BASE_URL = 'https://api.openai.com/v1'

export function VisionAnalyzerSection() {
  const visionAnalyzer = useCustomAiStore((s) => s.visionAnalyzer)
  const setVisionAnalyzer = useCustomAiStore((s) => s.setVisionAnalyzer)
  const resetVisionAnalyzer = useCustomAiStore((s) => s.resetVisionAnalyzer)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const modelOptions = useMemo<ComboboxOption[]>(
    () =>
      visionAnalyzer.cachedModels.map((entry) => ({
        value: entry.id,
        label: entry.label && entry.label !== entry.id ? `${entry.label} (${entry.id})` : entry.id,
      })),
    [visionAnalyzer.cachedModels],
  )

  const canLoad = Boolean(visionAnalyzer.baseUrl.trim() && visionAnalyzer.apiKey.trim())

  const handleLoad = useCallback(async () => {
    if (!canLoad) return
    setLoading(true)
    setError(null)
    try {
      const models = await fetchCustomAiModels(visionAnalyzer.baseUrl.trim(), visionAnalyzer.apiKey)
      const stillSelected =
        visionAnalyzer.model && models.some((entry) => entry.id === visionAnalyzer.model)
      setVisionAnalyzer({
        cachedModels: models,
        lastLoadedAt: Date.now(),
        model: stillSelected ? visionAnalyzer.model : (models[0]?.id ?? ''),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load models')
    } finally {
      setLoading(false)
    }
  }, [
    canLoad,
    visionAnalyzer.apiKey,
    visionAnalyzer.baseUrl,
    visionAnalyzer.model,
    setVisionAnalyzer,
  ])

  const isPristine =
    !visionAnalyzer.baseUrl &&
    !visionAnalyzer.apiKey &&
    !visionAnalyzer.model &&
    !visionAnalyzer.highlightFinderPrompt &&
    visionAnalyzer.cachedModels.length === 0

  const promptIsCustom = visionAnalyzer.highlightFinderPrompt.trim().length > 0

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-sm">Base URL</Label>
        <Input
          type="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={PLACEHOLDER_BASE_URL}
          value={visionAnalyzer.baseUrl}
          onChange={(event) => setVisionAnalyzer({ baseUrl: event.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm">API Key</Label>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-..."
            value={visionAnalyzer.apiKey}
            onChange={(event) => setVisionAnalyzer({ apiKey: event.target.value })}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={handleLoad}
            disabled={!canLoad || loading}
            className="shrink-0"
          >
            {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {loading ? 'Loading' : 'Load'}
          </Button>
        </div>
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm">Model</Label>
        <Combobox
          value={visionAnalyzer.model}
          options={modelOptions}
          onValueChange={(value) => setVisionAnalyzer({ model: value })}
          placeholder={modelOptions.length === 0 ? 'Load models to choose…' : 'Select a model'}
          searchPlaceholder="Search models..."
          emptyMessage="No models loaded yet."
          disabled={modelOptions.length === 0}
        />
        <p className="text-xs text-muted-foreground">
          Vision-capable model required for <strong>Analyze with AI → Custom AI</strong> (e.g.{' '}
          <code className="text-foreground">gpt-4o-mini</code>,{' '}
          <code className="text-foreground">gemini-2.5-flash</code>). Same model is also used by{' '}
          <strong>Highlight Finder</strong> for text reasoning.
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm">Highlight Finder Prompt</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
            onClick={() => setVisionAnalyzer({ highlightFinderPrompt: '' })}
            disabled={!promptIsCustom}
            aria-label="Reset Highlight Finder prompt to default"
          >
            <RotateCcw className="h-3 w-3" />
            Reset prompt
          </Button>
        </div>
        <Textarea
          value={visionAnalyzer.highlightFinderPrompt}
          onChange={(event) => setVisionAnalyzer({ highlightFinderPrompt: event.target.value })}
          placeholder={DEFAULT_HIGHLIGHT_FINDER_SYSTEM_PROMPT}
          rows={8}
          spellCheck={false}
          className="min-h-32 resize-y font-mono text-[11px]"
        />
        <p className="text-xs text-muted-foreground">
          Customize the system prompt sent to the chat model for <strong>Highlight Finder</strong>.
          Leave empty to use the default (shown as placeholder). The user message (clips + targets)
          is always appended automatically.
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        Used by <strong>Analyze with AI → Custom AI</strong> (per-frame vision captioning) and by{' '}
        <strong>Highlight Finder</strong> (text-only reasoning over captions + transcripts).
      </p>

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => {
            setError(null)
            resetVisionAnalyzer()
          }}
          disabled={isPristine}
        >
          Reset
        </Button>
      </div>
    </div>
  )
}
