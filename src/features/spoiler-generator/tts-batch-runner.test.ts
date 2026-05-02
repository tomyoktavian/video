import { describe, expect, it } from 'vite-plus/test'

import { summarizeBatch } from './tts-batch-runner'
import type { TtsBatchOutcome } from './types'

describe('summarizeBatch', () => {
  it('counts successes and failures', () => {
    const results: TtsBatchOutcome[] = [
      { index: 0, blob: new Blob(), durationSec: 1, mediaId: 'm-0' },
      { index: 1, error: 'boom' },
      { index: 2, blob: new Blob(), durationSec: 1, mediaId: 'm-2' },
    ]
    expect(summarizeBatch(results)).toEqual({
      total: 3,
      succeeded: 2,
      failed: 1,
      failureRate: 1 / 3,
    })
  })

  it('reports zero rate for empty batch', () => {
    expect(summarizeBatch([])).toEqual({
      total: 0,
      succeeded: 0,
      failed: 0,
      failureRate: 0,
    })
  })

  it('reports 100% failure when all error out', () => {
    const results: TtsBatchOutcome[] = [
      { index: 0, error: 'a' },
      { index: 1, error: 'b' },
    ]
    expect(summarizeBatch(results)).toEqual({
      total: 2,
      succeeded: 0,
      failed: 2,
      failureRate: 1,
    })
  })
})
