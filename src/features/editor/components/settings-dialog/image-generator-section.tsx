import { useCallback, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCustomAiStore } from '@/features/editor/deps/settings-contract'
import { fetchCustomAiModels } from '@/features/editor/deps/media-library-contract'

const PLACEHOLDER_BASE_URL = 'https://api.openai.com/v1'

export function ImageGeneratorSection() {
  const imageGenerator = useCustomAiStore((s) => s.imageGenerator)
  const setImageGenerator = useCustomAiStore((s) => s.setImageGenerator)
  const resetImageGenerator = useCustomAiStore((s) => s.resetImageGenerator)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const modelOptions = useMemo<ComboboxOption[]>(
    () =>
      imageGenerator.cachedModels.map((entry) => ({
        value: entry.id,
        label: entry.label && entry.label !== entry.id ? `${entry.label} (${entry.id})` : entry.id,
      })),
    [imageGenerator.cachedModels],
  )

  const canLoad = Boolean(imageGenerator.baseUrl.trim() && imageGenerator.apiKey.trim())

  const handleLoad = useCallback(async () => {
    if (!canLoad) return
    setLoading(true)
    setError(null)
    try {
      const models = await fetchCustomAiModels(imageGenerator.baseUrl.trim(), imageGenerator.apiKey)
      const stillSelected =
        imageGenerator.model && models.some((entry) => entry.id === imageGenerator.model)
      setImageGenerator({
        cachedModels: models,
        lastLoadedAt: Date.now(),
        model: stillSelected ? imageGenerator.model : (models[0]?.id ?? ''),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load models')
    } finally {
      setLoading(false)
    }
  }, [
    canLoad,
    imageGenerator.apiKey,
    imageGenerator.baseUrl,
    imageGenerator.model,
    setImageGenerator,
  ])

  const isPristine =
    !imageGenerator.baseUrl &&
    !imageGenerator.apiKey &&
    !imageGenerator.model &&
    imageGenerator.cachedModels.length === 0

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-sm">Base URL</Label>
        <Input
          type="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={PLACEHOLDER_BASE_URL}
          value={imageGenerator.baseUrl}
          onChange={(event) => setImageGenerator({ baseUrl: event.target.value })}
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
            value={imageGenerator.apiKey}
            onChange={(event) => setImageGenerator({ apiKey: event.target.value })}
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
          value={imageGenerator.model}
          options={modelOptions}
          onValueChange={(value) => setImageGenerator({ model: value })}
          placeholder={modelOptions.length === 0 ? 'Load models to choose…' : 'Select a model'}
          searchPlaceholder="Search models..."
          emptyMessage="No models loaded yet."
          disabled={modelOptions.length === 0}
        />
        <div className="space-y-2 rounded-md border border-border/60 bg-secondary/30 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <p>
            Image-generation model used by <strong>Add Cover → Generate with AI</strong> and the{' '}
            <strong>AI sidebar → Image Generation</strong> section. The endpoint is
            OpenAI-compatible <code className="text-foreground">/images/generations</code>.
          </p>
          <p className="text-foreground">
            Recommended: <code className="text-foreground">gemini-2.5-flash-image-preview</code>{' '}
            (Gemini <strong>nano-banana-2</strong>) — fastest, cheapest, and most permissive about
            prompt content + aspect ratios.
          </p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              <strong>Google Gemini (nano-banana-2):</strong> set Base URL to{' '}
              <code className="text-foreground">
                https://generativelanguage.googleapis.com/v1beta/openai/
              </code>{' '}
              and pick <code className="text-foreground">gemini-2.5-flash-image-preview</code>.
              Honours both <code className="text-foreground">size</code> and{' '}
              <code className="text-foreground">aspect_ratio</code>, no quality tier needed.
            </li>
            <li>
              <strong>OpenAI gpt-image-1:</strong> only accepts the sizes{' '}
              <code className="text-foreground">1024x1024 / 1024x1536 / 1536x1024</code> and ignores{' '}
              <code className="text-foreground">aspect_ratio</code>. The adapter auto-adjusts when
              the model name contains <code className="text-foreground">gpt-image</code>.
            </li>
            <li>
              <strong>xAI Grok / OpenRouter / LiteLLM proxies:</strong> work as long as the upstream
              model is OpenAI-compatible. Watch out for budget caps on the proxy.
            </li>
          </ul>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => {
            setError(null)
            resetImageGenerator()
          }}
          disabled={isPristine}
        >
          Reset
        </Button>
      </div>
    </div>
  )
}
