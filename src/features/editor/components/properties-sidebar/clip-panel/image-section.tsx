import { useCallback, useMemo } from "react";
import { Image, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ImageItem, TimelineItem } from "@/types/timeline";
import type { CanvasSettings } from "@/types/transform";
import { useTimelineStore } from "@/features/editor/deps/timeline-store";
import { useGizmoStore } from "@/features/editor/deps/preview";
import {
  resolveTransform,
  getSourceDimensions,
} from "@/features/editor/deps/composition-runtime";
import { resolveAnimatedTransform } from "@/features/editor/deps/keyframes";
import { PropertySection, PropertyRow, SliderInput } from "../components";
import {
  ITEM_ANIMATION_PRESETS,
  buildItemAnimationKeyframes,
  getItemAnimationFrameRange,
  type ItemAnimationPhase,
  type ItemAnimationPresetOptionId,
} from "./item-animation-presets";

interface ImageSectionProps {
  items: TimelineItem[];
  canvas: CanvasSettings;
}

/**
 * Image section - properties for image items (opacity, effects, animation)
 */
export function ImageSection({ items, canvas }: ImageSectionProps) {
  const updateItem = useTimelineStore((s) => s.updateItem);
  const addKeyframes = useTimelineStore((s) => s.addKeyframes);

  // Gizmo store for live property preview
  const setPropertiesPreviewNew = useGizmoStore(
    (s) => s.setPropertiesPreviewNew,
  );
  const clearPreview = useGizmoStore((s) => s.clearPreview);

  // Filter to only image items
  const imageItems = useMemo(
    () => items.filter((item): item is ImageItem => item.type === "image"),
    [items],
  );

  // Memoize item IDs for stable callback dependencies
  const itemIds = useMemo(
    () => imageItems.map((item) => item.id),
    [imageItems],
  );

  // Get shared values across selected image items
  const sharedValues = useMemo(() => {
    if (imageItems.length === 0) return null;

    const first = imageItems[0]!;
    return {
      fadeIn: imageItems.every((i) => (i.fadeIn ?? 0) === (first.fadeIn ?? 0))
        ? (first.fadeIn ?? 0)
        : ("mixed" as const),
      fadeOut: imageItems.every(
        (i) => (i.fadeOut ?? 0) === (first.fadeOut ?? 0),
      )
        ? (first.fadeOut ?? 0)
        : ("mixed" as const),
    };
  }, [imageItems]);

  const finalizePreviewChange = useCallback(() => {
    queueMicrotask(() => clearPreview());
  }, [clearPreview]);

  // Fade In handlers
  const handleFadeInLiveChange = useCallback(
    (value: number) => {
      const previews: Record<string, { fadeIn: number }> = {};
      itemIds.forEach((id) => {
        previews[id] = { fadeIn: value };
      });
      setPropertiesPreviewNew(previews);
    },
    [itemIds, setPropertiesPreviewNew],
  );

  const handleFadeInChange = useCallback(
    (value: number) => {
      imageItems.forEach((item) => {
        updateItem(item.id, { fadeIn: value });
      });
      finalizePreviewChange();
    },
    [finalizePreviewChange, imageItems, updateItem],
  );

  // Fade Out handlers
  const handleFadeOutLiveChange = useCallback(
    (value: number) => {
      const previews: Record<string, { fadeOut: number }> = {};
      itemIds.forEach((id) => {
        previews[id] = { fadeOut: value };
      });
      setPropertiesPreviewNew(previews);
    },
    [itemIds, setPropertiesPreviewNew],
  );

  const handleFadeOutChange = useCallback(
    (value: number) => {
      imageItems.forEach((item) => {
        updateItem(item.id, { fadeOut: value });
      });
      finalizePreviewChange();
    },
    [finalizePreviewChange, imageItems, updateItem],
  );

  // Animation preset handler
  const handleApplyAnimationPreset = useCallback(
    (phase: ItemAnimationPhase, presetId: ItemAnimationPresetOptionId) => {
      const keyframes = useTimelineStore.getState().keyframes;
      const payloads = imageItems.flatMap((item) => {
        const baseResolved = resolveTransform(
          item,
          canvas,
          getSourceDimensions(item),
        );
        const itemKeyframes = keyframes.find(
          (entry) => entry.itemId === item.id,
        );
        const frameRange = getItemAnimationFrameRange(
          item.durationInFrames,
          canvas.fps,
          phase,
        );
        if (!frameRange) {
          return [];
        }
        const anchorTransform = resolveAnimatedTransform(
          baseResolved,
          itemKeyframes,
          phase === "intro" ? frameRange.endFrame : frameRange.startFrame,
        );

        return buildItemAnimationKeyframes({
          item,
          presetId,
          phase,
          fps: canvas.fps,
          anchorTransform,
          itemKeyframes,
        });
      });

      if (payloads.length === 0) {
        return;
      }

      addKeyframes(payloads);
    },
    [addKeyframes, canvas, imageItems],
  );

  if (imageItems.length === 0 || !sharedValues) {
    return null;
  }

  return (
    <>
      <PropertySection title="Image" icon={Image} defaultOpen={true}>
        {/* Source Info */}
        {imageItems.length === 1 && imageItems[0] && (
          <PropertyRow label="Source">
            <div className="text-xs text-muted-foreground truncate flex-1 min-w-0">
              {imageItems[0].sourceWidth && imageItems[0].sourceHeight
                ? `${imageItems[0].sourceWidth} × ${imageItems[0].sourceHeight}`
                : "Unknown dimensions"}
            </div>
          </PropertyRow>
        )}

        {/* Fade In */}
        <PropertyRow label="Fade In">
          <SliderInput
            value={sharedValues.fadeIn}
            onChange={handleFadeInChange}
            onLiveChange={handleFadeInLiveChange}
            min={0}
            max={5}
            step={0.1}
            unit="s"
            className="flex-1 min-w-0"
          />
        </PropertyRow>

        {/* Fade Out */}
        <PropertyRow label="Fade Out">
          <SliderInput
            value={sharedValues.fadeOut}
            onChange={handleFadeOutChange}
            onLiveChange={handleFadeOutLiveChange}
            min={0}
            max={5}
            step={0.1}
            unit="s"
            className="flex-1 min-w-0"
          />
        </PropertyRow>
      </PropertySection>

      <PropertySection title="Effects" icon={Sparkles} defaultOpen={true}>
        <div className="px-1 pt-1 text-[11px] text-muted-foreground">
          Use the Effects tab for GPU shader effects (blur, color grade, etc.)
        </div>
      </PropertySection>

      <PropertySection title="Animation" icon={Sparkles} defaultOpen={true}>
        <PropertyRow label="Intro" className="items-start">
          <div className="grid w-full grid-cols-4 gap-1.5">
            {ITEM_ANIMATION_PRESETS.map((preset) => (
              <Button
                key={preset.id}
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => handleApplyAnimationPreset("intro", preset.id)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </PropertyRow>
        <PropertyRow label="Outro" className="items-start">
          <div className="grid w-full grid-cols-4 gap-1.5">
            {ITEM_ANIMATION_PRESETS.map((preset) => (
              <Button
                key={`outro-${preset.id}`}
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => handleApplyAnimationPreset("outro", preset.id)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </PropertyRow>
        <div className="px-1 pt-1 text-[11px] text-muted-foreground">
          Applies short ease-out motion at the start or end of each selected
          clip.
        </div>
      </PropertySection>
    </>
  );
}
