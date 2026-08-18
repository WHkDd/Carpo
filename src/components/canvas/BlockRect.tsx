import { memo } from "react";
import { Rect } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type { Rect as KRect } from "konva/lib/shapes/Rect";
import type { Block } from "@/store/pageStateSlice";
import { articleHsl, cssHsl } from "@/lib/article-color-token";
import { tweenFill } from "./tween-fill";

export interface BlockRectProps {
  block: Block;
  isSelected: boolean;
  isEditing?: boolean;
  scale: number;
  interactive: boolean;
  articleNum?: number;
  isHighlighted?: boolean;
  colorVersion: number;
  registerRef: (id: string, node: KRect | null) => void;
  onMouseDown: (e: KonvaEventObject<MouseEvent>) => void;
  onTransformEnd: (e: KonvaEventObject<Event>) => void;
  onDragStart: (e: KonvaEventObject<DragEvent>) => void;
  onDragMove: (e: KonvaEventObject<DragEvent>) => void;
  onDragEnd: (e: KonvaEventObject<DragEvent>) => void;
}

function BlockRectImpl(props: BlockRectProps) {
  const {
    block,
    isSelected,
    isEditing,
    scale,
    interactive,
    articleNum,
    isHighlighted,
    colorVersion,
    registerRef,
    onMouseDown,
    onTransformEnd,
    onDragStart,
    onDragMove,
    onDragEnd,
  } = props;

  const hasArticle = articleNum != null;
  // Parent increments this when article colour CSS tokens change; receiving
  // the prop is enough to re-render and recompute the cached colour strings.
  void colorVersion;

  const baseFill = isSelected
    ? hasArticle
      ? articleHsl(articleNum!, 0.38)
      : cssHsl("--canvas-accent", 0.38)
    : hasArticle
      ? articleHsl(articleNum!, 0.15)
      : cssHsl("--canvas-accent", 0.15);
  const hoverFill = isSelected
    ? hasArticle
      ? articleHsl(articleNum!, 0.42)
      : cssHsl("--canvas-accent", 0.42)
    : hasArticle
      ? articleHsl(articleNum!, 0.32)
      : cssHsl("--canvas-accent", 0.32);
  // A block that belongs to a highlighted article is outlined in the app's
  // graphite --primary rather than the accent, so the outline reads as "this
  // one is picked out" against neighbours already tinted by article colour.
  const stroke = isHighlighted
    ? cssHsl("--primary", 1, "0 0% 15%")
    : hasArticle
      ? articleHsl(articleNum!, 1)
      : isSelected
        ? cssHsl("--canvas-accent-strong")
        : cssHsl("--canvas-accent");

  return (
    <Rect
      id={block.id}
      ref={(node) => registerRef(block.id, node)}
      x={block.x}
      y={block.y}
      width={block.w}
      height={block.h}
      fill={baseFill}
      stroke={stroke}
      strokeWidth={(isHighlighted || isSelected || isEditing ? 2 : 1) / scale}
      perfectDrawEnabled={false}
      shadowForStrokeEnabled={false}
      hitStrokeWidth={Math.max(1, 12 / scale)}
      listening={interactive}
      draggable={interactive}
      onMouseDown={onMouseDown}
      onTransformEnd={onTransformEnd}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onMouseEnter={(e) => {
        tweenFill(e.target, hoverFill);
      }}
      onMouseLeave={(e) => {
        tweenFill(e.target, baseFill);
      }}
    />
  );
}

export const BlockRect = memo(BlockRectImpl);
