import { useCallback, useMemo, useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useCustomAiStore } from '@/features/editor/deps/settings-contract'
import { fetchCustomAiModels } from '@/features/editor/deps/media-library-contract'
import { DEFAULT_HIGHLIGHT_FINDER_SYSTEM_PROMPT } from '@/features/editor/deps/highlight-finder'
import {
  DEFAULT_COVER_FINDER_SYSTEM_PROMPT,
  DEFAULT_POSTER_PROMPT_SYSTEM_PROMPT,
} from '@/features/editor/deps/compound-cover'
import { DEFAULT_SCRIPT_WRITER_SYSTEM_PROMPT } from '@/features/editor/deps/spoiler-generator'

const PLACEHOLDER_BASE_URL = 'https://api.openai.com/v1'

export function VisionAnalyzerSection() {
  const { t } = useTranslation()
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
      setError(err instanceof Error ? err.message : t('settings.visionAnalyzer.failedToLoadModels'))
    } finally {
      setLoading(false)
    }
  }, [
    canLoad,
    visionAnalyzer.apiKey,
    visionAnalyzer.baseUrl,
    visionAnalyzer.model,
    setVisionAnalyzer,
    t,
  ])

  const isPristine =
    !visionAnalyzer.baseUrl &&
    !visionAnalyzer.apiKey &&
    !visionAnalyzer.model &&
    !visionAnalyzer.highlightFinderPrompt &&
    !visionAnalyzer.coverFinderPrompt &&
    !visionAnalyzer.scriptWriterPrompt &&
    !visionAnalyzer.posterPromptSystemPrompt &&
    visionAnalyzer.cachedModels.length === 0

  const promptIsCustom = visionAnalyzer.highlightFinderPrompt.trim().length > 0
  const coverPromptIsCustom = visionAnalyzer.coverFinderPrompt.trim().length > 0
  const scriptPromptIsCustom = visionAnalyzer.scriptWriterPrompt.trim().length > 0
  const posterPromptIsCustom = visionAnalyzer.posterPromptSystemPrompt.trim().length > 0

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-sm">{t('settings.visionAnalyzer.baseUrl')}</Label>
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
        <Label className="text-sm">{t('settings.visionAnalyzer.apiKey')}</Label>
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
            {loading ? t('settings.visionAnalyzer.loading') : t('settings.visionAnalyzer.load')}
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
        <Label className="text-sm">{t('settings.visionAnalyzer.model')}</Label>
        <Combobox
          value={visionAnalyzer.model}
          options={modelOptions}
          onValueChange={(value) => setVisionAnalyzer({ model: value })}
          placeholder={
            modelOptions.length === 0
              ? t('settings.visionAnalyzer.loadModelsToChoose')
              : t('settings.visionAnalyzer.selectAModel')
          }
          searchPlaceholder={t('settings.visionAnalyzer.searchModels')}
          emptyMessage={t('settings.visionAnalyzer.noModelsLoaded')}
          disabled={modelOptions.length === 0}
        />
        <p className="text-xs text-muted-foreground">
          <Trans
            i18nKey="settings.visionAnalyzer.modelHint"
            components={{ s: <strong />, c: <code className="text-foreground" /> }}
          />
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t('settings.visionAnalyzer.highlightFinderPrompt')}</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
            onClick={() => setVisionAnalyzer({ highlightFinderPrompt: '' })}
            disabled={!promptIsCustom}
            aria-label={t('settings.visionAnalyzer.resetHighlightFinderPromptAria')}
          >
            <RotateCcw className="h-3 w-3" />
            {t('settings.visionAnalyzer.resetPrompt')}
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
          <Trans
            i18nKey="settings.visionAnalyzer.highlightFinderPromptHint"
            components={{ s: <strong /> }}
          />
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t('settings.visionAnalyzer.coverTextPrompt')}</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
            onClick={() => setVisionAnalyzer({ coverFinderPrompt: '' })}
            disabled={!coverPromptIsCustom}
            aria-label={t('settings.visionAnalyzer.resetCoverTextPromptAria')}
          >
            <RotateCcw className="h-3 w-3" />
            {t('settings.visionAnalyzer.resetPrompt')}
          </Button>
        </div>
        <Textarea
          value={visionAnalyzer.coverFinderPrompt}
          onChange={(event) => setVisionAnalyzer({ coverFinderPrompt: event.target.value })}
          placeholder={DEFAULT_COVER_FINDER_SYSTEM_PROMPT}
          rows={6}
          spellCheck={false}
          className="min-h-32 resize-y font-mono text-[11px]"
        />
        <p className="text-xs text-muted-foreground">
          <Trans
            i18nKey="settings.visionAnalyzer.coverTextPromptHint"
            components={{ s: <strong /> }}
          />
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t('settings.visionAnalyzer.scriptWriterPrompt')}</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
            onClick={() => setVisionAnalyzer({ scriptWriterPrompt: '' })}
            disabled={!scriptPromptIsCustom}
            aria-label={t('settings.visionAnalyzer.resetScriptWriterPromptAria')}
          >
            <RotateCcw className="h-3 w-3" />
            {t('settings.visionAnalyzer.resetPrompt')}
          </Button>
        </div>
        <Textarea
          value={visionAnalyzer.scriptWriterPrompt}
          onChange={(event) => setVisionAnalyzer({ scriptWriterPrompt: event.target.value })}
          placeholder={DEFAULT_SCRIPT_WRITER_SYSTEM_PROMPT}
          rows={8}
          spellCheck={false}
          className="min-h-32 resize-y font-mono text-[11px]"
        />
        <p className="text-xs text-muted-foreground">
          <Trans
            i18nKey="settings.visionAnalyzer.scriptWriterPromptHint"
            components={{ s: <strong /> }}
          />
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t('settings.visionAnalyzer.posterPrompt')}</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
            onClick={() => setVisionAnalyzer({ posterPromptSystemPrompt: '' })}
            disabled={!posterPromptIsCustom}
            aria-label={t('settings.visionAnalyzer.resetPosterPromptAria')}
          >
            <RotateCcw className="h-3 w-3" />
            {t('settings.visionAnalyzer.resetPrompt')}
          </Button>
        </div>
        <Textarea
          value={visionAnalyzer.posterPromptSystemPrompt}
          onChange={(event) => setVisionAnalyzer({ posterPromptSystemPrompt: event.target.value })}
          placeholder={DEFAULT_POSTER_PROMPT_SYSTEM_PROMPT}
          rows={8}
          spellCheck={false}
          className="min-h-32 resize-y font-mono text-[11px]"
        />
        <p className="text-xs text-muted-foreground">
          <Trans
            i18nKey="settings.visionAnalyzer.posterPromptHint"
            components={{ s: <strong /> }}
          />
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        <Trans i18nKey="settings.visionAnalyzer.usedByHint" components={{ s: <strong /> }} />
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
          {t('settings.visionAnalyzer.reset')}
        </Button>
      </div>
    </div>
  )
}
