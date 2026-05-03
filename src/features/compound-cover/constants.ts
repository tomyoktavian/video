export const COVER_DURATION_BOUNDS = {
  min: 0.1,
  max: 5,
  step: 0.1,
  default: 0.5,
} as const

export type CoverDurationBounds = typeof COVER_DURATION_BOUNDS
