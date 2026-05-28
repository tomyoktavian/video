import type { AnimatableProperty, Keyframe } from '@/types/keyframe'
import { getPropertyAccordionGroups } from './property-groups'
import type { DopesheetPropertyGroup, DopesheetPropertyRow } from './dopesheet-types'

export function getNiceTickStep(frameRange: number): number {
  const rough = Math.max(1, frameRange / 10)
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)))
  const normalized = rough / magnitude
  if (normalized <= 1) return magnitude
  if (normalized <= 2) return 2 * magnitude
  if (normalized <= 5) return 5 * magnitude
  return 10 * magnitude
}

export function arePreviewFramesEqual(
  a: Record<string, number> | null,
  b: Record<string, number> | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return a === b

  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false

  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }

  return true
}

export function buildGroupedPropertyRows(
  rows: DopesheetPropertyRow[],
  currentFrame: number,
): DopesheetPropertyGroup[] {
  const rowByProperty = new Map<AnimatableProperty, DopesheetPropertyRow>(
    rows.map((row) => [row.property, row]),
  )

  return getPropertyAccordionGroups(rows.map((row) => row.property))
    .map((group) => {
      const groupedRows = group.properties.flatMap((property) => {
        const row = rowByProperty.get(property)
        return row ? [row] : []
      })
      const keyframeEntries = groupedRows
        .flatMap((row) => row.keyframes.map((keyframe) => ({ property: row.property, keyframe })))
        .toSorted((a, b) => a.keyframe.frame - b.keyframe.frame)
      const frameGroups = keyframeEntries.reduce<
        Array<{
          frame: number
          keyframes: Array<{ property: AnimatableProperty; keyframe: Keyframe }>
        }>
      >((groups, entry) => {
        const lastGroup = groups.at(-1)
        if (lastGroup && lastGroup.frame === entry.keyframe.frame) {
          lastGroup.keyframes.push(entry)
        } else {
          groups.push({
            frame: entry.keyframe.frame,
            keyframes: [entry],
          })
        }
        return groups
      }, [])
      const currentKeyframes =
        frameGroups.find((groupEntries) => groupEntries.frame === currentFrame)?.keyframes ?? []

      let prevKeyframe: { property: AnimatableProperty; keyframe: Keyframe } | null = null
      let nextKeyframe: { property: AnimatableProperty; keyframe: Keyframe } | null = null

      for (let index = frameGroups.length - 1; index >= 0; index -= 1) {
        const frameGroup = frameGroups[index]
        if (frameGroup && frameGroup.frame < currentFrame) {
          prevKeyframe = frameGroup.keyframes[0] ?? null
          break
        }
      }

      for (const frameGroup of frameGroups) {
        if (frameGroup.frame > currentFrame) {
          nextKeyframe = frameGroup.keyframes[0] ?? null
          break
        }
      }

      return {
        id: group.id,
        label: group.label,
        rows: groupedRows,
        frameGroups,
        currentKeyframes,
        hasKeyframeAtCurrentFrame: currentKeyframes.length > 0,
        prevKeyframe,
        nextKeyframe,
      }
    })
    .filter((group) => group.rows.length > 0)
}
