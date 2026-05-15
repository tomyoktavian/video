import { Check, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { SpoilerStage } from '../types'

interface StageDef {
  stage: SpoilerStage
  labelKey: string
}

const STAGE_ORDER: StageDef[] = [
  { stage: 'transcribing', labelKey: 'spoiler.progress.transcribe' },
  { stage: 'writing-script', labelKey: 'spoiler.progress.writeScript' },
  { stage: 'resolving-highlights', labelKey: 'spoiler.progress.pickClips' },
  { stage: 'generating-narration', labelKey: 'spoiler.progress.generateNarration' },
  { stage: 'transcribing-narration', labelKey: 'spoiler.progress.subtitleTiming' },
  { stage: 'planning-episodes', labelKey: 'spoiler.progress.planEpisodes' },
  { stage: 'generating-episode-narration', labelKey: 'spoiler.progress.episodeBoundaries' },
  { stage: 'syncing-durations', labelKey: 'spoiler.progress.syncDurations' },
  { stage: 'applying-highlights', labelKey: 'spoiler.progress.buildCompound' },
  { stage: 'inserting-subtitles', labelKey: 'spoiler.progress.subtitles' },
  { stage: 'inserting-cover', labelKey: 'spoiler.progress.cover' },
]

export interface SpoilerProgressStepperProps {
  currentStage: SpoilerStage
  showSubtitles: boolean
  showCover: boolean
  episodeMode: boolean
}

function stageIndex(stage: SpoilerStage): number {
  const idx = STAGE_ORDER.findIndex((entry) => entry.stage === stage)
  return idx === -1 ? -1 : idx
}

export function SpoilerProgressStepper(props: SpoilerProgressStepperProps) {
  const { t } = useTranslation()
  const stages = STAGE_ORDER.filter((stage) => {
    if (stage.stage === 'transcribing-narration' && !props.showSubtitles) return false
    if (stage.stage === 'inserting-subtitles' && !props.showSubtitles) return false
    if (stage.stage === 'inserting-cover' && !props.showCover) return false
    if (stage.stage === 'planning-episodes' && !props.episodeMode) return false
    if (stage.stage === 'generating-episode-narration' && !props.episodeMode) return false
    return true
  })

  const currentIdx = stageIndex(props.currentStage)
  const isDone = props.currentStage === 'done'
  const isError = props.currentStage === 'error'

  return (
    <ol className="space-y-2">
      {stages.map((stage) => {
        const idx = stageIndex(stage.stage)
        const completed = isDone || (currentIdx >= 0 && idx < currentIdx)
        const active = !isDone && !isError && idx === currentIdx
        return (
          <li
            key={stage.stage}
            className="flex items-center gap-2.5 text-xs"
            data-state={completed ? 'completed' : active ? 'active' : 'pending'}
          >
            <span
              className={
                'flex h-5 w-5 items-center justify-center rounded-full border ' +
                (completed
                  ? 'border-primary bg-primary text-primary-foreground'
                  : active
                    ? 'border-primary text-primary'
                    : 'border-muted-foreground/30 text-muted-foreground/60')
              }
            >
              {completed ? (
                <Check className="h-3 w-3" />
              ) : active ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
              )}
            </span>
            <span
              className={
                completed
                  ? 'text-foreground'
                  : active
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground/70'
              }
            >
              {t(stage.labelKey)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
