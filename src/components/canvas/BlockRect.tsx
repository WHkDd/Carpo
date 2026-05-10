import { memo } from "react";
import { Rect } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type { Rect as KRect } from "konva/lib/shapes/Rect";
import type { Block } from "@/store/pageStateSlice";

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
    registerRef,
    onMouseDown,
    onTransformEnd,
    onDragStart,
    onDragMove,
    onDragEnd,
  } = props;

  const baseFill = isSelected ? FILL_SELECTED : FILL_BASE;
  const hoverFill = isSelected ? FILL_SELECTED_HOVER : FILL_HOVER;

  return (
    <Rect
      id={block.id}
      ref={(node) => registerRef(block.id, node)}
      x={block.x}
      y={block.y}
      width={block.w}
      height={block.h}
      fill={baseFill}
      stroke={isSelected ? STROKE_SELECTED : STROKE_BASE}
      strokeWidth={(isSelected ? 2 : 1) / scale}
      listening={interactive}
      draggable={interactive}
      onMouseDown={onMouseDown}
      onTransformEnd={onTransformEnd}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onMouseEnter={(e) => {
        (e.target as KRect).fill(hoverFill);
      }}
      onMouseLeave={(e) => {
        (e.target as KRect).fill(baseFill);
      }}
    />
  );
}

export const BlockRect = memo(BlockRectImpl);
