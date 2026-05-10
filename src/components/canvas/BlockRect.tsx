import { memo, useMemo } from "react";
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

export interface BlockRectProps {
  block: Block;
  isSelected: boolean;
  scale: number;
  interactive: boolean;
  articleNum?: number;
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
    scale,
    interactive,
    articleNum,
    colorVersion,
    registerRef,
    onMouseDown,
    onTransformEnd,
    onDragStart,
    onDragMove,
    onDragEnd,
  } = props;

  const hasArticle = articleNum != null;

  const baseFill = useMemo(() => {
    if (isSelected) {
      return hasArticle ? articleHsl(articleNum!, 0.38) : FILL_SELECTED;
    }
    return hasArticle ? articleHsl(articleNum!, 0.15) : FILL_BASE;
  }, [isSelected, articleNum, hasArticle, colorVersion]);

  const hoverFill = useMemo(() => {
    if (isSelected) {
      return hasArticle ? articleHsl(articleNum!, 0.42) : FILL_SELECTED_HOVER;
    }
    return hasArticle ? articleHsl(articleNum!, 0.32) : FILL_HOVER;
  }, [isSelected, articleNum, hasArticle, colorVersion]);

  const stroke = useMemo(() => {
    if (hasArticle) return articleHsl(articleNum!, 1);
    return isSelected ? STROKE_SELECTED : STROKE_BASE;
  }, [isSelected, articleNum, hasArticle, colorVersion]);

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
      strokeWidth={(isSelected ? 2 : 1) / scale}
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
