import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  useSettingsStore,
  CAPTIONING_INTERVAL_BOUNDS,
  DEFAULT_CAPTIONING_INTERVAL_SECONDS,
  resolveCaptioningIntervalSec,
  type CaptioningIntervalUnit,
} from '@/features/editor/deps/settings'
import { cn } from '@/shared/ui/cn'

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

export function AiSection() {
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
