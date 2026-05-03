/**
 * Image lightbox — wraps any clickable element (image, canvas, button) and
 * opens a centred fullscreen-ish preview of the source image with a download
 * action. Uses Radix Dialog primitives directly (rather than the shadcn
 * `<Dialog>` wrapper) so the content can render edge-to-edge with no built-in
 * padding around the image.
 *
 * Usage:
 *
 *   <ImageLightbox src={objectUrl} alt="Generated poster" downloadFilename="poster.png">
 *     <button type="button" className="...">
 *       <img src={objectUrl} alt="" />
 *     </button>
 *   </ImageLightbox>
 *
 * The child element acts as the trigger; clicking it opens the lightbox.
 */
import { useCallback, useState, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Download, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/shared/ui/cn'

interface ImageLightboxProps {
  /** Image source — `blob:`, `data:`, `https:` URLs all work. */
  src: string
  /** Alt text for the image and the dialog title (sr-only). */
  alt?: string
  /**
   * Suggested filename when the user clicks Download. Falls back to the URL's
   * pathname tail when omitted, then to `image.png`.
   */
  downloadFilename?: string
  /** Optional className applied to the rendered `<img>` inside the lightbox. */
  imageClassName?: string
  /** The element used to open the lightbox — passed to Radix `DialogTrigger`. */
  children: ReactNode
}

function deriveFilename(src: string): string | undefined {
  try {
    const url = new URL(src, window.location.href)
    const last = url.pathname.split('/').pop()
    if (last && last.includes('.')) return last
  } catch {
    // ignore
  }
  return undefined
}

export function ImageLightbox({
  src,
  alt = 'Image preview',
  downloadFilename,
  imageClassName,
  children,
}: ImageLightboxProps) {
  const [open, setOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const handleDownload = useCallback(async () => {
    setDownloading(true)
    let blobUrl: string | null = null
    try {
      // Re-fetch through `fetch()` so we can also handle remote URLs and force
      // a real blob download (not a navigation). Works for `blob:` URLs too.
      const response = await fetch(src)
      const blob = await response.blob()
      blobUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = downloadFilename ?? deriveFilename(src) ?? 'image.png'
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } catch {
      // Fall back to a direct anchor download — works for same-origin URLs at
      // least, even if `fetch` was blocked by CORS.
      const link = document.createElement('a')
      link.href = src
      link.download = downloadFilename ?? deriveFilename(src) ?? 'image.png'
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } finally {
      // Defer revoke so the download has a chance to start.
      if (blobUrl) {
        const url = blobUrl
        window.setTimeout(() => URL.revokeObjectURL(url), 4000)
      }
      setDownloading(false)
    }
  }, [src, downloadFilename])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>{children}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/90',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          )}
        />
        <DialogPrimitive.Content
          // No fixed width / max-width — we let the image size itself within
          // the viewport via `max-w-[95vw] max-h-[95vh]` so portraits, squares,
          // and ultra-wide panoramas all render at their best size.
          className={cn(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[95vh] max-w-[95vw] flex-col items-center gap-3 outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          )}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">{alt}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Press Escape or click the close button to dismiss.
          </DialogPrimitive.Description>

          <div className="relative flex max-h-[88vh] max-w-[95vw] items-center justify-center">
            <img
              src={src}
              alt={alt}
              className={cn(
                'block max-h-[88vh] max-w-[95vw] rounded-lg object-contain shadow-2xl',
                imageClassName,
              )}
            />
            <DialogPrimitive.Close asChild>
              <Button
                size="icon"
                variant="secondary"
                className="absolute right-2 top-2 h-8 w-8 shadow-lg"
                aria-label="Close preview"
              >
                <X className="h-4 w-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>

          <Button
            size="sm"
            variant="secondary"
            onClick={() => void handleDownload()}
            disabled={downloading}
            className="gap-1.5 shadow-lg"
          >
            <Download className="h-3.5 w-3.5" />
            {downloading ? 'Downloading…' : 'Download'}
          </Button>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
