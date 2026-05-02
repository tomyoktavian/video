import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  useSettingsStore,
  CAPTIONING_INTERVAL_BOUNDS,
  DEFAULT_CAPTIONING_INTERVAL_SECONDS,
  resolveCaptioningIntervalSec,
  type CaptioningIntervalUnit,
  type SubtitleGranularity,
} from '@/features/editor/deps/settings'
import { isAnyCustomAiConfigured, useCustomAiStore } from '@/features/editor/deps/settings-contract'
import { cn } from '@/shared/ui/cn'
import { CaptionMakerSection } from './caption-maker-section'
import { TextToSpeechSection } from './text-to-speech-section'
import { VisionAnalyzerSection } from './vision-analyzer-section'

const ESTIMATE_REFERENCE_DURATION_SEC = 60
const ESTIMATE_REFERENCE_FPS = 30

function formatCaptionEstimate(unit: CaptioningIntervalUnit, value: number): string {
  const intervalSec = resolveCaptioningIntervalSec(unit, value, ESTIMATE_REFERENCE_FPS)
  if (intervalSec <= 0) {
    return 'Enter an interval above zero.'
  }
  const sceneCount = Math.max(1, Math.round(ESTIMATE_REFERENCE_DURATION_SEC / intervalSec))
  return `~${sceneCount} ${sceneCount === 1 ? 'scene' : 'scenes'} per 1-min clip at ${ESTIMATE_REFERENCE_FPS}fps`
}

function LocalAiTab() {
  const captioningIntervalUnit = useSettingsStore((s) => s.captioningIntervalUnit)
  const captioningIntervalValue = useSettingsStore((s) => s.captioningIntervalValue)
  const setSetting = useSettingsStore((s) => s.setSetting)

  const intervalBounds = CAPTIONING_INTERVAL_BOUNDS[captioningIntervalUnit]
  const intervalInputStep = captioningIntervalUnit === 'seconds' ? 0.5 : 1
  const intervalUnitLabel = captioningIntervalUnit === 'seconds' ? 'sec' : 'frames'

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label className="text-sm">Caption sample interval</Label>
            <p className="text-xs text-muted-foreground">
              How often Analyze with AI samples a frame for captioning.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border border-border bg-secondary p-0.5">
            {(['seconds', 'frames'] as const).map((unit) => (
              <button
                key={unit}
                type="button"
                onClick={() => setSetting('captioningIntervalUnit', unit)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs transition-colors',
                  captioningIntervalUnit === unit
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {unit === 'seconds' ? 'Seconds' : 'Frames'}
              </button>
            ))}
          </div>
          <Input
            type="number"
            inputMode="decimal"
            className="h-8 w-24"
            min={intervalBounds.min}
            max={intervalBounds.max}
            step={intervalInputStep}
            value={captioningIntervalValue}
            onChange={(event) => {
              const parsed = Number(event.target.value)
              if (Number.isFinite(parsed)) {
                setSetting('captioningIntervalValue', parsed)
              }
            }}
          />
          <span className="text-xs text-muted-foreground">{intervalUnitLabel}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => {
              setSetting('captioningIntervalUnit', 'seconds')
              setSetting('captioningIntervalValue', DEFAULT_CAPTIONING_INTERVAL_SECONDS)
            }}
            disabled={
              captioningIntervalUnit === 'seconds' &&
              captioningIntervalValue === DEFAULT_CAPTIONING_INTERVAL_SECONDS
            }
          >
            Reset
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {formatCaptionEstimate(captioningIntervalUnit, captioningIntervalValue)}. Smaller
          intervals produce denser scenes but take longer to generate.
        </p>
      </div>
    </div>
  )
}

function CustomAiTab() {
  return (
    <Accordion type="single" collapsible defaultValue="caption-maker" className="w-full">
      <AccordionItem value="caption-maker">
        <AccordionTrigger>Caption Maker</AccordionTrigger>
        <AccordionContent>
          <CaptionMakerSection />
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="text-to-speech">
        <AccordionTrigger>Text to Speech</AccordionTrigger>
        <AccordionContent>
          <TextToSpeechSection />
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="vision-analyzer">
        <AccordionTrigger>Vision Analyzer</AccordionTrigger>
        <AccordionContent>
          <VisionAnalyzerSection />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

const SUBTITLE_GRANULARITY_OPTIONS: ReadonlyArray<{
  value: SubtitleGranularity
  label: string
  description: string
}> = [
  {
    value: 'word',
    label: 'Per word',
    description: 'Karaoke style — one word per text item, lights up with the spoken syllable.',
  },
  {
    value: 'phrase',
    label: 'Per phrase (default)',
    description: '4–5 word groups, TikTok / CapCut style. Easiest to read for short-form clips.',
  },
  {
    value: 'sentence',
    label: 'Per sentence',
    description: 'Full sentence per line, movie-subtitle style. Best for long-form / cinematic.',
  },
]

function SubtitleOutputSection() {
  const granularity = useSettingsStore((s) => s.defaultSubtitleGranularity)
  const setSetting = useSettingsStore((s) => s.setSetting)

  return (
    <div className="mb-3 space-y-2 rounded-lg border border-border bg-secondary/30 p-3">
      <div className="space-y-0.5">
        <Label className="text-sm">Subtitle output granularity</Label>
        <p className="text-xs text-muted-foreground">
          Berlaku untuk semua pembuatan subtitle: <strong>Generate Captions</strong> di clip,{' '}
          <strong>Highlight Finder</strong>, dan <strong>Auto Spoiler Generator</strong>. Dapat
          di-override per-run di dialog masing-masing.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {SUBTITLE_GRANULARITY_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setSetting('defaultSubtitleGranularity', option.value)}
            className={cn(
              'rounded-md border px-2.5 py-1 text-xs transition-colors',
              granularity === option.value
                ? 'border-primary/40 bg-primary/15 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
            title={option.description}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {SUBTITLE_GRANULARITY_OPTIONS.find((o) => o.value === granularity)?.description}
      </p>
    </div>
  )
}

export function AiSection() {
  const anyCustomConfigured = useCustomAiStore((s) =>
    isAnyCustomAiConfigured({
      captionMaker: s.captionMaker,
      textToSpeech: s.textToSpeech,
      visionAnalyzer: s.visionAnalyzer,
    }),
  )
  // `key` forces re-mount when the configured signal flips so Radix Tabs
  // picks up the new `defaultValue` without requiring the user to close
  // and reopen the settings dialog.
  const initialTab = anyCustomConfigured ? 'custom' : 'local'
  return (
    <div className="w-full">
      <SubtitleOutputSection />
      <Tabs key={initialTab} defaultValue={initialTab} className="w-full">
        <TabsList>
          <TabsTrigger value="local">Local AI</TabsTrigger>
          <TabsTrigger value="custom">Custom AI</TabsTrigger>
        </TabsList>
        <TabsContent value="local">
          <LocalAiTab />
        </TabsContent>
        <TabsContent value="custom">
          <CustomAiTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
