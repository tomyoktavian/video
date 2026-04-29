import { memo, useCallback, useEffect, useState } from 'react';
import { Copy, Check, FileText, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useTranscriptViewerDialogStore } from '@/app/state/transcript-viewer-dialog';
import { getTranscript } from '@/infrastructure/storage';
import type { MediaTranscript, MediaTranscriptSegment } from '@/types/storage';

function formatTimestamp(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const TranscriptViewerDialog = memo(function TranscriptViewerDialog() {
  const isOpen = useTranscriptViewerDialogStore((s) => s.isOpen);
  const mediaId = useTranscriptViewerDialogStore((s) => s.mediaId);
  const fileName = useTranscriptViewerDialogStore((s) => s.fileName);
  const close = useTranscriptViewerDialogStore((s) => s.close);

  const [transcript, setTranscript] = useState<MediaTranscript | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen || !mediaId) {
      setTranscript(null);
      setError(null);
      setCopied(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getTranscript(mediaId)
      .then((result) => {
        if (cancelled) return;
        if (result) {
          setTranscript(result);
        } else {
          setError('Transcript not found.');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load transcript.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, mediaId]);

  const handleCopyFullText = useCallback(() => {
    if (!transcript) return;
    navigator.clipboard.writeText(transcript.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [transcript]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) close();
    },
    [close],
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary" />
            Transcript
          </DialogTitle>
          {fileName && (
            <DialogDescription className="truncate">
              {fileName}
            </DialogDescription>
          )}
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            {error}
          </div>
        )}

        {transcript && !loading && (
          <>
            {/* Meta info */}
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <div className="flex items-center gap-3">
                <span>Model: <span className="text-foreground">{transcript.model}</span></span>
                {transcript.language && (
                  <span>Lang: <span className="text-foreground">{transcript.language}</span></span>
                )}
                <span>Segments: <span className="text-foreground">{transcript.segments.length}</span></span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={handleCopyFullText}
              >
                {copied ? (
                  <>
                    <Check className="w-3 h-3 text-green-500" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    Copy All
                  </>
                )}
              </Button>
            </div>

            {/* Full text */}
            {transcript.text && (
              <div className="rounded-lg border border-border bg-secondary/30 p-3 text-xs leading-relaxed text-foreground whitespace-pre-wrap max-h-24 overflow-y-auto">
                {transcript.text}
              </div>
            )}

            {/* Segments */}
            {transcript.segments.length > 0 && (
              <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border bg-secondary/20">
                <div className="divide-y divide-border/50">
                  {transcript.segments.map((seg: MediaTranscriptSegment, i: number) => (
                    <div key={i} className="flex gap-3 px-3 py-2 hover:bg-secondary/30 transition-colors">
                      <span className="text-[10px] font-mono text-primary/80 shrink-0 w-20 pt-0.5 tabular-nums">
                        {formatTimestamp(seg.start)} – {formatTimestamp(seg.end)}
                      </span>
                      <span className="text-xs text-foreground leading-relaxed">
                        {seg.text.trim()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
});
