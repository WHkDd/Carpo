import { useCallback, useEffect, useRef, useState } from "react";
import type { KonvaEventObject } from "konva/lib/Node";
import type { Stage } from "konva/lib/Stage";

export type DrawState =
  | { kind: "idle" }
  | { kind: "drawing"; startX: number; startY: number; curX: number; curY: number };

const MIN_SCREEN_DIM = 6;

export interface OnBlockCreated {
  (rect: { x: number; y: number; w: number; h: number }): void;
}

export interface UseDrawBlockArgs {
  stageRef: React.RefObject<Stage | null>;
  manualDrawMode: boolean;
  onBlockCreated: OnBlockCreated;
}

export interface UseDrawBlockReturn {
  drawState: DrawState;
  handlers: {
    onMouseDown: (e: KonvaEventObject<MouseEvent>) => void;
    onMouseMove: (e: KonvaEventObject<MouseEvent>) => void;
    onMouseUp: (e: KonvaEventObject<MouseEvent>) => void;
  };
}

function isCanvasTarget(e: KonvaEventObject<MouseEvent>): boolean {
  // Image layer is listening:false, so the only background hit is the Stage itself.
  // Block Rects and Transformer anchors are excluded by this check.
  return e.target === e.target.getStage();
}

function stageToImage(stage: Stage, sx: number, sy: number) {
  const scaleX = stage.scaleX() || 1;
  const scaleY = stage.scaleY() || 1;
  return {
    x: (sx - stage.x()) / scaleX,
    y: (sy - stage.y()) / scaleY,
  };
}

export function useDrawBlock(args: UseDrawBlockArgs): UseDrawBlockReturn {
  const { stageRef, manualDrawMode, onBlockCreated } = args;
  const [drawState, setDrawState] = useState<DrawState>({ kind: "idle" });
  const onBlockCreatedRef = useRef(onBlockCreated);
  onBlockCreatedRef.current = onBlockCreated;

  const onMouseDown = useCallback(
    (e: KonvaEventObject<MouseEvent>) => {
      if (!manualDrawMode) return;
      if (e.evt.button !== 0) return;
      const stage = stageRef.current;
      if (!stage) return;
      if (!isCanvasTarget(e)) return;

      const pos = stage.getPointerPosition();
      if (!pos) return;
      const img = stageToImage(stage, pos.x, pos.y);
      setDrawState({ kind: "drawing", startX: img.x, startY: img.y, curX: img.x, curY: img.y });
    },
    [manualDrawMode, stageRef]
  );

  const onMouseMove = useCallback(
    (_e: KonvaEventObject<MouseEvent>) => {
      if (drawState.kind !== "drawing") return;
      const stage = stageRef.current;
      if (!stage) return;
      const pos = stage.getPointerPosition();
      if (!pos) return;
      const img = stageToImage(stage, pos.x, pos.y);
      setDrawState((prev) =>
        prev.kind === "drawing"
          ? { ...prev, curX: img.x, curY: img.y }
          : prev
      );
    },
    [drawState.kind, stageRef]
  );

  const onMouseUp = useCallback(() => {
    if (drawState.kind !== "drawing") return;
    const stage = stageRef.current;
    const { startX, startY, curX, curY } = drawState;
    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);
    const scale = stage?.scaleX() || 1;
    if (w * scale >= MIN_SCREEN_DIM && h * scale >= MIN_SCREEN_DIM) {
      onBlockCreatedRef.current({ x, y, w, h });
    }
    setDrawState({ kind: "idle" });
  }, [drawState, stageRef]);

  // Global Escape handler
  useEffect(() => {
    if (!manualDrawMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawState({ kind: "idle" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [manualDrawMode]);

  return {
    drawState,
    handlers: { onMouseDown, onMouseMove, onMouseUp },
  };
}
