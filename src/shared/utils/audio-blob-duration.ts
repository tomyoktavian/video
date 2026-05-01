/**
 * Decode an audio blob and return its duration in seconds.
 *
 * Uses `AudioContext.decodeAudioData`, which handles MP3/WAV/OGG/Opus uniformly
 * and returns an exact duration (vs. the brittle `<audio>`-element/`loadedmetadata`
 * race that can report `Infinity` for some streamed-style MP3s).
 *
 * Returns `0` if the platform lacks an AudioContext or the bytes can't be decoded.
 */
export async function getAudioBlobDurationSeconds(blob: Blob): Promise<number> {
  type AudioContextCtor = typeof AudioContext
  const Ctor: AudioContextCtor | undefined =
    typeof window === 'undefined'
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext)
  if (!Ctor) return 0

  const ctx = new Ctor()
  try {
    const arrayBuffer = await blob.arrayBuffer()
    const buffer = await ctx.decodeAudioData(arrayBuffer)
    return buffer.duration
  } catch {
    return 0
  } finally {
    void ctx.close()
  }
}
