import { describe, expect, it } from 'vite-plus/test'
import {
  DEFAULT_MEDIA_CAPTIONING_PROVIDER_ID,
  getDefaultMediaCaptioningProvider,
  mediaCaptioningProviderRegistry,
} from './registry'

describe('mediaCaptioningProviderRegistry', () => {
  it('exposes the default captioning provider through the registry', () => {
    expect(DEFAULT_MEDIA_CAPTIONING_PROVIDER_ID).toBe('lfm-captioning')
    expect(getDefaultMediaCaptioningProvider()).toMatchObject({
      id: 'lfm-captioning',
      label: 'LFM 2.5 VL',
    })
    // LFM (default) + openai-compatible-vision (added when Custom AI vision shipped).
    expect(mediaCaptioningProviderRegistry.list()).toHaveLength(2)
    expect(mediaCaptioningProviderRegistry.list().map((p) => p.id)).toContain(
      'openai-compatible-vision',
    )
  })
})
