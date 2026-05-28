import { ProviderRegistry } from '@/shared/utils/provider-registry'
import { lfmCaptioningProvider } from './lfm-captioning-provider'
import {
  openaiCompatibleVisionProvider,
  OPENAI_COMPATIBLE_VISION_PROVIDER_ID,
} from './openai-compatible-vision-provider'
import type { MediaCaptioningProvider } from './types'

export const DEFAULT_MEDIA_CAPTIONING_PROVIDER_ID = lfmCaptioningProvider.id

export { OPENAI_COMPATIBLE_VISION_PROVIDER_ID }

export const mediaCaptioningProviderRegistry = new ProviderRegistry<MediaCaptioningProvider>(
  [lfmCaptioningProvider, openaiCompatibleVisionProvider],
  DEFAULT_MEDIA_CAPTIONING_PROVIDER_ID,
)

export function getDefaultMediaCaptioningProvider(): MediaCaptioningProvider {
  return mediaCaptioningProviderRegistry.getDefault()
}

export function getMediaCaptioningProvider(id: string | undefined): MediaCaptioningProvider {
  if (!id) return mediaCaptioningProviderRegistry.getDefault()
  try {
    return mediaCaptioningProviderRegistry.get(id)
  } catch {
    return mediaCaptioningProviderRegistry.getDefault()
  }
}
