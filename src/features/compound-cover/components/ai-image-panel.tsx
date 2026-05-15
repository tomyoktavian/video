import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ImageIcon, Loader2, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/shared/ui/cn'

import { COVER_DURATION_BOUNDS } from '../constants'
import { buildCoverImagePromptFromForm, summariseCoverTranscript } from '../cover-service'
import { generateCoverImage } from '../openai-compatible-image-adapter'
import {
  buildFreeformImagePrompt,
  POSTER_CAST_OPTIONS,
  POSTER_MOOD_OPTIONS,
  POSTER_QUALITY_OPTIONS,
  POSTER_STYLE_OPTIONS,
  resolvePosterQualityApiValue,
  type PosterCastValue,
  type PosterMoodValue,
  type PosterQualityValue,
  type PosterStyleValue,
} from '../system-prompt'

import { AspectRatioIcon } from './aspect-ratio-icon'
import {
  ASPECT_RATIO_OPTIONS,
  pickAspectRatioFromCanvas,
  resolveImageDimensions,
} from './aspect-ratio-options'

export type AiImagePromptMode = 'split' | 'single'

/** Snapshot of every form field value at the moment generation succeeded. */
export interface AiImageFormSnapshot {
  /** Title (split mode only — empty in single mode). */
  title: string
  /** Transcript (split mode only — empty in single mode). */
  transcript: string
  /** Prompt body (single mode only — empty in split mode). */
  prompt: string
  aspect: string
  cast: PosterCastValue
  style: PosterStyleValue
  mood: PosterMoodValue
  quality: PosterQualityValue
  customNotes: string
}

export interface AiImageGeneratedPayload {
  blob: Blob
  /** Object URL for preview — kept alive by the panel until next regen. */
  previewUrl: string
  width: number
  height: number
  /** Final prompt actually sent to the image generator. */
  resolvedPrompt: string
  /** Form values at generation time, for tagging / history rows. */
  form: AiImageFormSnapshot
  /** Display label of the chosen aspect-ratio option. */
  aspectLabel: string
}

export interface AiImagePanelDurationField {
  valueSec: number
  onChange: (sec: number) => void
  minSec?: number
  maxSec?: number
  step?: number
  label?: string
  helpText?: string
}

export interface AiImagePanelProps {
  /** Project canvas dimensions used as a fallback when aspect = 'auto'. */
  width: number
  height: number

  /** Whether to render `title + transcript` ('split') or a single prompt textarea ('single'). */
  promptMode: AiImagePromptMode

  /** Image generator config check + identifying labels for the header line. */
  imageGeneratorConfigured: boolean
  imageGeneratorModel?: string
  imageGeneratorBaseUrl?: string
  /** Vision Analyzer config check — gates the transcript "Generate summary" button. */
  visionAnalyzerConfigured?: boolean

  /** Initial form values; component manages state internally afterwards. */
  initialValues?: Partial<AiImageFormSnapshot>

  /**
   * Optional controlled field overrides — useful when the parent needs to
   * drive a value from elsewhere (e.g. Spoiler dialog pre-fills transcript
   * from the source media). Passing a `controlled*` prop makes the panel
   * surrender ownership of that field; the panel stops setting its own
   * internal state for it.
   */
  controlledTitle?: { value: string; onChange: (v: string) => void }
  controlledTranscript?: { value: string; onChange: (v: string) => void }
  controlledPrompt?: { value: string; onChange: (v: string) => void }

  /**
   * Show the "Generate summary" button next to the transcript label. Only
   * applies in `'split'` mode and requires the Vision Analyzer to be
   * configured (the button auto-disables otherwise).
   */
  enableTranscriptSummarise?: boolean

  /**
   * Optional cover-duration field rendered below the Generate row. Only
   * useful when the AI image is going to be consumed as a cover (Add Cover
   * dialog, Spoiler Generator). Sidebar AI omits this prop.
   */
  durationField?: AiImagePanelDurationField

  /** Visual variant — sidebar (compact, smaller paddings) vs dialog (comfortable). */
  variant?: 'sidebar' | 'dialog'

  /** Disable every input + the Generate button (e.g. parent is busy persisting). */
  disabled?: boolean

  /**
   * Show a "Cancel" button while generating that aborts the in-flight
   * request. Defaults to `true`. Sidebar uses this; cover/spoiler dialogs
   * keep it on too because nothing prevents an interrupt.
   */
  showCancelButton?: boolean

  /** Override the Generate button label. Defaults to "Generate image". */
  generateLabel?: string

  /** Hide the built-in current-preview block (caller renders its own). */
  hideCurrentPreview?: boolean

  /**
   * Optional slot rendered below the current preview. Use for
   * domain-specific extras like the sidebar AI's saved-generations list.
   */
  historySlot?: ReactNode

  /**
   * Called after a successful generation. Parent is responsible for
   * persisting / using the blob — the panel only owns the in-memory preview.
   */
  onImageGenerated?: (payload: AiImageGeneratedPayload) => void
  /** Called when the user clicks Cancel during generation (after abort). */
  onCancelled?: () => void

  /**
   * Whether to require non-empty transcript before allowing generation.
   * Defaults to `true` for split mode and `false` for single mode.
   */
  requireTranscript?: boolean

  /** Filename used for downloading from the preview lightbox. */
  downloadFilenamePrefix?: string

  /** Extra content slotted into the right side of the Generate button row. */
  generateRowExtras?: ReactNode
}

const DEFAULT_DURATION_BOUNDS = {
  min: COVER_DURATION_BOUNDS.min,
  max: COVER_DURATION_BOUNDS.max,
  step: COVER_DURATION_BOUNDS.step,
}

export function AiImagePanel(props: AiImagePanelProps) {
  const { t } = useTranslation()
  const {
    width,
    height,
    promptMode,
    imageGeneratorConfigured,
    imageGeneratorModel,
    imageGeneratorBaseUrl,
    visionAnalyzerConfigured = false,
    initialValues,
    controlledTitle,
    controlledTranscript,
    controlledPrompt,
    enableTranscriptSummarise = false,
    durationField,
    variant = 'dialog',
    disabled = false,
    showCancelButton = true,
    generateLabel: generateLabelProp,
    hideCurrentPreview = false,
    historySlot,
    onImageGenerated,
    onCancelled,
    requireTranscript = promptMode === 'split',
    downloadFilenamePrefix = 'ai-image',
    generateRowExtras,
  } = props
  const generateLabel = generateLabelProp ?? t('compoundCover.aiImagePanel.generateImage')

  const compact = variant === 'sidebar'

  const [title, setTitle] = useState<string>(initialValues?.title ?? '')
  const [transcript, setTranscript] = useState<string>(initialValues?.transcript ?? '')
  const [prompt, setPrompt] = useState<string>(initialValues?.prompt ?? '')
  const [aspect, setAspect] = useState<string>(
    initialValues?.aspect ?? pickAspectRatioFromCanvas(width, height),
  )
  const [cast, setCast] = useState<PosterCastValue>(initialValues?.cast ?? 'auto')
  const [style, setStyle] = useState<PosterStyleValue>(initialValues?.style ?? 'photoreal')
  const [mood, setMood] = useState<PosterMoodValue>(initialValues?.mood ?? 'auto')
  const [quality, setQuality] = useState<PosterQualityValue>(initialValues?.quality ?? 'auto')
  const [customNotes, setCustomNotes] = useState<string>(initialValues?.customNotes ?? '')

  const [imageBlob, setImageBlob] = useState<Blob | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isSummarising, setIsSummarising] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const generateAbortRef = useRef<AbortController | null>(null)
  const summaryAbortRef = useRef<AbortController | null>(null)

  // Surface controlled values when present, otherwise use local state.
  const effectiveTitle = controlledTitle ? controlledTitle.value : title
  const effectiveTranscript = controlledTranscript ? controlledTranscript.value : transcript
  const effectivePrompt = controlledPrompt ? controlledPrompt.value : prompt

  const onTitleChange = controlledTitle?.onChange ?? setTitle
  const onTranscriptChange = controlledTranscript?.onChange ?? setTranscript
  const onPromptChange = controlledPrompt?.onChange ?? setPrompt

  // Revoke object URL on unmount.
  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl)
      generateAbortRef.current?.abort()
      summaryAbortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const promptHasContent = useMemo(() => {
    if (promptMode === 'single') return effectivePrompt.trim().length > 0
    if (requireTranscript) return effectiveTranscript.trim().length > 0
    // Split + transcript optional: title or transcript suffices.
    return effectiveTitle.trim().length > 0 || effectiveTranscript.trim().length > 0
  }, [promptMode, effectivePrompt, effectiveTitle, effectiveTranscript, requireTranscript])

  const canGenerate =
    imageGeneratorConfigured && !isGenerating && !isSummarising && !disabled && promptHasContent

  const handleSummarise = useCallback(async () => {
    if (effectiveTranscript.trim().length === 0) {
      setErrorMessage(t('compoundCover.aiImagePanel.noTranscriptError'))
      return
    }
    if (!visionAnalyzerConfigured) {
      setErrorMessage(t('compoundCover.aiImagePanel.configureVisionAnalyzerError'))
      return
    }
    setErrorMessage(null)
    setIsSummarising(true)
    const controller = new AbortController()
    summaryAbortRef.current = controller
    try {
      const summary = await summariseCoverTranscript({
        transcript: effectiveTranscript,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      onTranscriptChange(summary)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setErrorMessage(
        error instanceof Error ? error.message : t('compoundCover.aiImagePanel.summariseFailed'),
      )
    } finally {
      if (summaryAbortRef.current === controller) summaryAbortRef.current = null
      setIsSummarising(false)
    }
  }, [effectiveTranscript, visionAnalyzerConfigured, onTranscriptChange, t])

  const handleGenerate = useCallback(async () => {
    if (!imageGeneratorConfigured) {
      setErrorMessage(t('compoundCover.aiImagePanel.configureImageGeneratorError'))
      return
    }
    let resolvedPrompt: string
    try {
      const aspectForPrompt = aspect === 'auto' ? '' : aspect
      if (promptMode === 'split') {
        resolvedPrompt = buildCoverImagePromptFromForm({
          title: effectiveTitle,
          transcript: effectiveTranscript,
          aspectLabel: aspectForPrompt,
          cast,
          style,
          mood,
          customNotes,
        })
      } else {
        resolvedPrompt = buildFreeformImagePrompt({
          prompt: effectivePrompt,
          aspectLabel: aspectForPrompt,
          cast,
          style,
          mood,
          customNotes,
        })
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t('compoundCover.aiImagePanel.cannotBuildPrompt'),
      )
      return
    }

    setErrorMessage(null)
    setIsGenerating(true)
    const controller = new AbortController()
    generateAbortRef.current = controller
    try {
      const dims = resolveImageDimensions(aspect, width, height)
      const apiQuality = resolvePosterQualityApiValue(quality)
      const result = await generateCoverImage({
        prompt: resolvedPrompt,
        width: dims.width,
        height: dims.height,
        ...(apiQuality ? { quality: apiQuality } : {}),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return

      setImageBlob(result.blob)
      const newUrl = URL.createObjectURL(result.blob)
      setImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return newUrl
      })

      const form: AiImageFormSnapshot = {
        title: effectiveTitle,
        transcript: effectiveTranscript,
        prompt: effectivePrompt,
        aspect,
        cast,
        style,
        mood,
        quality,
        customNotes,
      }
      const aspectLabel = ASPECT_RATIO_OPTIONS.find((o) => o.value === aspect)?.label ?? aspect

      onImageGenerated?.({
        blob: result.blob,
        previewUrl: newUrl,
        width: result.width || dims.width,
        height: result.height || dims.height,
        resolvedPrompt,
        form,
        aspectLabel,
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        onCancelled?.()
        return
      }
      setErrorMessage(
        error instanceof Error
          ? error.message
          : t('compoundCover.aiImagePanel.generateImageFailed'),
      )
    } finally {
      if (generateAbortRef.current === controller) generateAbortRef.current = null
      setIsGenerating(false)
    }
  }, [
    imageGeneratorConfigured,
    aspect,
    promptMode,
    effectiveTitle,
    effectiveTranscript,
    effectivePrompt,
    cast,
    style,
    mood,
    customNotes,
    width,
    height,
    quality,
    onImageGenerated,
    onCancelled,
    t,
  ])

  const handleCancel = useCallback(() => {
    generateAbortRef.current?.abort()
  }, [])

  const labelTextClass = compact ? 'text-xs' : 'text-xs'
  const fieldGapClass = compact ? 'space-y-2' : 'space-y-3'
  const previewMaxHeight = compact ? 'max-h-[240px]' : 'h-[280px] w-auto'

  const minDur = durationField?.minSec ?? DEFAULT_DURATION_BOUNDS.min
  const maxDur = durationField?.maxSec ?? DEFAULT_DURATION_BOUNDS.max
  const stepDur = durationField?.step ?? DEFAULT_DURATION_BOUNDS.step

  return (
    <div className={fieldGapClass}>
      {imageGeneratorConfigured ? (
        imageGeneratorModel ? (
          <p className="text-[11px] text-muted-foreground">
            {t('compoundCover.aiImagePanel.usingModelPrefix')}{' '}
            <span className="font-medium text-foreground">{imageGeneratorModel}</span>
            {imageGeneratorBaseUrl ? (
              <> {t('compoundCover.aiImagePanel.viaBaseUrl', { baseUrl: imageGeneratorBaseUrl })}</>
            ) : null}
          </p>
        ) : null
      ) : (
        <p
          role="alert"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
        >
          {t('compoundCover.aiImagePanel.configureImageGeneratorHint')}
        </p>
      )}

      {promptMode === 'split' ? (
        <>
          <div className="space-y-1.5">
            <Label className={labelTextClass}>{t('compoundCover.aiImagePanel.titleLabel')}</Label>
            <Input
              value={effectiveTitle}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder={t('compoundCover.aiImagePanel.titlePlaceholder')}
              disabled={disabled || isGenerating}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className={labelTextClass}>
                {t('compoundCover.aiImagePanel.transcriptLabel')}
              </Label>
              {enableTranscriptSummarise && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
                  onClick={() => void handleSummarise()}
                  disabled={
                    isSummarising ||
                    isGenerating ||
                    disabled ||
                    !visionAnalyzerConfigured ||
                    effectiveTranscript.trim().length === 0
                  }
                >
                  {isSummarising ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  {isSummarising
                    ? t('compoundCover.aiImagePanel.summarising')
                    : t('compoundCover.aiImagePanel.generateSummary')}
                </Button>
              )}
            </div>
            <Textarea
              value={effectiveTranscript}
              onChange={(event) => onTranscriptChange(event.target.value)}
              placeholder={t('compoundCover.aiImagePanel.transcriptPlaceholder')}
              rows={compact ? 4 : 6}
              spellCheck={false}
              className="resize-y text-sm"
              disabled={disabled || isGenerating}
            />
            {enableTranscriptSummarise && !visionAnalyzerConfigured && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                {t('compoundCover.aiImagePanel.configureVisionAnalyzerHint')}
              </p>
            )}
          </div>
        </>
      ) : (
        <div className="space-y-1.5">
          <Label className={labelTextClass}>{t('compoundCover.aiImagePanel.promptLabel')}</Label>
          <Textarea
            value={effectivePrompt}
            onChange={(event) => onPromptChange(event.target.value)}
            placeholder={t('compoundCover.aiImagePanel.promptPlaceholder')}
            rows={compact ? 4 : 6}
            spellCheck={false}
            className={cn('resize-y text-sm', compact && 'min-h-24 bg-secondary/30')}
            disabled={disabled || isGenerating}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('compoundCover.aiImagePanel.aspectRatioLabel')}</Label>
          <Select value={aspect} onValueChange={setAspect} disabled={disabled || isGenerating}>
            <SelectTrigger className={compact ? 'h-8 text-xs' : 'h-9 text-sm'}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASPECT_RATIO_OPTIONS.map((opt) => (
                <SelectItem
                  key={opt.value}
                  value={opt.value}
                  className={compact ? 'text-xs' : 'text-sm'}
                >
                  <div className="flex items-center gap-2">
                    <AspectRatioIcon dim={opt.dim} />
                    <span>{opt.label}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">
            {t('compoundCover.aiImagePanel.targetCountryCastLabel')}
          </Label>
          <Select
            value={cast}
            onValueChange={(value) => setCast(value as PosterCastValue)}
            disabled={disabled || isGenerating}
          >
            <SelectTrigger className={compact ? 'h-8 text-xs' : 'h-9 text-sm'}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POSTER_CAST_OPTIONS.map((opt) => (
                <SelectItem
                  key={opt.value}
                  value={opt.value}
                  className={compact ? 'text-xs' : 'text-sm'}
                >
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('compoundCover.aiImagePanel.visualStyleLabel')}</Label>
          <Select
            value={style}
            onValueChange={(value) => setStyle(value as PosterStyleValue)}
            disabled={disabled || isGenerating}
          >
            <SelectTrigger className={compact ? 'h-8 text-xs' : 'h-9 text-sm'}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POSTER_STYLE_OPTIONS.map((opt) => (
                <SelectItem
                  key={opt.value}
                  value={opt.value}
                  className={compact ? 'text-xs' : 'text-sm'}
                >
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('compoundCover.aiImagePanel.moodGenreLabel')}</Label>
          <Select
            value={mood}
            onValueChange={(value) => setMood(value as PosterMoodValue)}
            disabled={disabled || isGenerating}
          >
            <SelectTrigger className={compact ? 'h-8 text-xs' : 'h-9 text-sm'}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POSTER_MOOD_OPTIONS.map((opt) => (
                <SelectItem
                  key={opt.value}
                  value={opt.value}
                  className={compact ? 'text-xs' : 'text-sm'}
                >
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">{t('compoundCover.aiImagePanel.imageQualityLabel')}</Label>
        <Select
          value={quality}
          onValueChange={(value) => setQuality(value as PosterQualityValue)}
          disabled={disabled || isGenerating}
        >
          <SelectTrigger className={compact ? 'h-8 text-xs' : 'h-9 text-sm'}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {POSTER_QUALITY_OPTIONS.map((opt) => (
              <SelectItem
                key={opt.value}
                value={opt.value}
                className={compact ? 'text-xs' : 'text-sm'}
              >
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          {t('compoundCover.aiImagePanel.qualityHintPrefix')}{' '}
          <code className="text-foreground">gpt-image-1</code>
          {t('compoundCover.aiImagePanel.qualityHintSuffix')}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">{t('compoundCover.aiImagePanel.customNotesLabel')}</Label>
        {compact ? (
          <Input
            value={customNotes}
            onChange={(event) => setCustomNotes(event.target.value)}
            placeholder={t('compoundCover.aiImagePanel.customNotesPlaceholderCompact')}
            className="h-8 text-xs"
            disabled={disabled || isGenerating}
          />
        ) : (
          <Textarea
            value={customNotes}
            onChange={(event) => setCustomNotes(event.target.value)}
            placeholder={t('compoundCover.aiImagePanel.customNotesPlaceholder')}
            rows={2}
            spellCheck={false}
            className="resize-y text-sm"
            disabled={disabled || isGenerating}
          />
        )}
      </div>

      {durationField && (
        <div className="space-y-1.5">
          <Label className="text-xs">
            {durationField.label ?? t('compoundCover.aiImagePanel.coverDurationLabel')}
          </Label>
          <Input
            type="number"
            min={minDur}
            max={maxDur}
            step={stepDur}
            value={durationField.valueSec}
            disabled={disabled || isGenerating}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next)) {
                durationField.onChange(Math.min(maxDur, Math.max(minDur, next)))
              }
            }}
          />
          {durationField.helpText && (
            <p className="text-[11px] text-muted-foreground">{durationField.helpText}</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {generateRowExtras}
        {showCancelButton && isGenerating && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            className="h-7 shrink-0 gap-1.5 text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
            {t('compoundCover.aiImagePanel.cancel')}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          onClick={() => void handleGenerate()}
          disabled={!canGenerate}
          className="h-7 shrink-0 gap-1.5"
        >
          {isGenerating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : imageBlob ? (
            <Sparkles className="h-3.5 w-3.5" />
          ) : (
            <ImageIcon className="h-3.5 w-3.5" />
          )}
          {isGenerating
            ? t('compoundCover.aiImagePanel.generating')
            : imageBlob
              ? t('compoundCover.aiImagePanel.regenerateLabel', {
                  label: generateLabel.toLowerCase(),
                })
              : generateLabel}
        </Button>
      </div>

      {errorMessage && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {errorMessage}
        </p>
      )}

      {!hideCurrentPreview && imageUrl && (
        <ImageLightbox
          src={imageUrl}
          alt={t('compoundCover.aiImagePanel.generatedPreviewAlt')}
          downloadFilename={`${downloadFilenamePrefix}-${Date.now()}.png`}
        >
          <button
            type="button"
            className="flex w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-md border border-border bg-secondary/40"
            aria-label={t('compoundCover.aiImagePanel.openGeneratedPreviewAriaLabel')}
          >
            <img
              src={imageUrl}
              alt={t('compoundCover.aiImagePanel.generatedPreviewAlt')}
              className={cn('block max-w-full', previewMaxHeight)}
              style={{ aspectRatio: width > 0 && height > 0 ? `${width} / ${height}` : undefined }}
            />
          </button>
        </ImageLightbox>
      )}
      {!hideCurrentPreview && !imageUrl && (
        <p className="text-xs text-muted-foreground">
          {t('compoundCover.aiImagePanel.rendersAtHint', {
            width,
            height,
            label: generateLabel.toLowerCase(),
          })}
        </p>
      )}

      {historySlot}
    </div>
  )
}
