import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { KeyframeMarqueeOverlay, type KeyframeMarqueeRect } from '../keyframe-marquee'
import { PROPERTY_COLUMN_WIDTH, RULER_HEIGHT } from './dopesheet-constants'

interface DopesheetSheetBodyProps {
  scrollAreaRef: React.RefObject<HTMLDivElement | null>
  hasRows: boolean
  emptyStateMessage: string
  rowElements: ReactNode
  marqueeRect: KeyframeMarqueeRect | null
  marqueeJustEnded: boolean
  onTimelineBackgroundPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function DopesheetSheetBody({
  scrollAreaRef,
  hasRows,
  emptyStateMessage,
  rowElements,
  marqueeRect,
  marqueeJustEnded,
  onTimelineBackgroundPointerDown,
}: DopesheetSheetBodyProps) {
  return (
    <div
      ref={scrollAreaRef}
      className="overflow-auto"
      style={{ height: `calc(100% - ${RULER_HEIGHT}px)` }}
    >
      {!hasRows ? (
        <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
          {emptyStateMessage}
        </div>
      ) : (
        <div className="relative min-h-full">
          <div
            data-testid="dopesheet-selection-surface"
            className="absolute inset-y-0 right-0 z-0"
            style={{ left: PROPERTY_COLUMN_WIDTH }}
            onPointerDown={onTimelineBackgroundPointerDown}
          />
          <div className="relative z-10">{rowElements}</div>
          {marqueeRect && !marqueeJustEnded && (
            <KeyframeMarqueeOverlay
              rect={{
                ...marqueeRect,
                x: PROPERTY_COLUMN_WIDTH + marqueeRect.x,
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}
