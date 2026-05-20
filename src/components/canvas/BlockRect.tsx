import { memo } from "react";
import { Rect } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type { Rect as KRect } from "konva/lib/shapes/Rect";
import type { Block } from "@/store/pageStateSlice";
import { articleHsl } from "@/lib/article-color-token";
import { tweenFill } from "./tween-fill";

const FILL_BASE = "rgba(59,130,246,0.15)";
const FILL_HOVER = "rgba(59,130,246,0.32)";
const FILL_SELECTED = "rgba(59,130,246,0.38)";
const FILL_SELECTED_HOVER = "rgba(59,130,246,0.42)";
const STROKE_BASE = "#3b82f6";
const STROKE_SELECTED = "#2563eb";

// Accent stroke for highlighted article blocks
const STROKE_HIGHLIGHT = "#242424";

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
      : FILL_SELECTED
    : hasArticle
      ? articleHsl(articleNum!, 0.15)
      : FILL_BASE;
  const hoverFill = isSelected
    ? hasArticle
      ? articleHsl(articleNum!, 0.42)
      : FILL_SELECTED_HOVER
    : hasArticle
      ? articleHsl(articleNum!, 0.32)
      : FILL_HOVER;
  const stroke = isHighlighted
    ? STROKE_HIGHLIGHT
    : hasArticle
      ? articleHsl(articleNum!, 1)
      : isSelected
        ? STROKE_SELECTED
        : STROKE_BASE;

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
