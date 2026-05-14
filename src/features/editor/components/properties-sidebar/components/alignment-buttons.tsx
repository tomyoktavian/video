import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
} from 'lucide-react'
import { cn } from '@/shared/ui/cn'

export type AlignmentType =
  | 'left'
  | 'center-h'
  | 'right'
  | 'top'
  | 'center-v'
  | 'bottom'
  | 'distribute-h'
  | 'distribute-v'

interface AlignmentButtonsProps {
  onAlign: (alignment: AlignmentType) => void
  disabled?: boolean
  className?: string
}

const horizontalAlignments: Array<{
  type: AlignmentType
  icon: typeof AlignStartVertical
  labelKey: string
}> = [
  { type: 'left', icon: AlignStartVertical, labelKey: 'editor.alignment.left' },
  { type: 'center-h', icon: AlignCenterVertical, labelKey: 'editor.alignment.centerHorizontally' },
  { type: 'right', icon: AlignEndVertical, labelKey: 'editor.alignment.right' },
]

const verticalAlignments: Array<{
  type: AlignmentType
  icon: typeof AlignStartHorizontal
  labelKey: string
}> = [
  { type: 'top', icon: AlignStartHorizontal, labelKey: 'editor.alignment.top' },
  { type: 'center-v', icon: AlignCenterHorizontal, labelKey: 'editor.alignment.centerVertically' },
  { type: 'bottom', icon: AlignEndHorizontal, labelKey: 'editor.alignment.bottom' },
]

const distributionAlignments: Array<{
  type: AlignmentType
  icon: typeof AlignHorizontalDistributeCenter
  labelKey: string
}> = [
  {
    type: 'distribute-h',
    icon: AlignHorizontalDistributeCenter,
    labelKey: 'editor.alignment.distributeHorizontally',
  },
  {
    type: 'distribute-v',
    icon: AlignVerticalDistributeCenter,
    labelKey: 'editor.alignment.distributeVertically',
  },
]

/**
 * Horizontal and vertical alignment button groups.
 * Used to align selected clips to canvas edges or center.
 */
export function AlignmentButtons({ onAlign, disabled = false, className }: AlignmentButtonsProps) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex items-center gap-3', className)}>
      {/* Horizontal alignment */}
      <div className="flex items-center gap-0.5 p-0.5 bg-secondary rounded-md">
        {horizontalAlignments.map(({ type, icon: Icon, labelKey }) => (
          <Button
            key={type}
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => onAlign(type)}
            disabled={disabled}
            data-tooltip={t(labelKey)}
            data-tooltip-side="bottom"
          >
            <Icon className="w-3.5 h-3.5" />
          </Button>
        ))}
      </div>

      {/* Vertical alignment */}
      <div className="flex items-center gap-0.5 p-0.5 bg-secondary rounded-md">
        {verticalAlignments.map(({ type, icon: Icon, labelKey }) => (
          <Button
            key={type}
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => onAlign(type)}
            disabled={disabled}
            data-tooltip={t(labelKey)}
            data-tooltip-side="bottom"
          >
            <Icon className="w-3.5 h-3.5" />
          </Button>
        ))}
      </div>

      {/* Distribution */}
      <div className="flex items-center gap-0.5 p-0.5 bg-secondary rounded-md">
        {distributionAlignments.map(({ type, icon: Icon, labelKey }) => (
          <Button
            key={type}
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => onAlign(type)}
            disabled={disabled}
            data-tooltip={t(labelKey)}
            data-tooltip-side="bottom"
          >
            <Icon className="w-3.5 h-3.5" />
          </Button>
        ))}
      </div>
    </div>
  )
}
