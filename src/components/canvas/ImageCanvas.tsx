import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { Stage, Layer, Image as KImage, Rect, Transformer } from "react-konva";
import { BlockRect } from "./BlockRect";
import type { Stage as KStage } from "konva/lib/Stage";
import type { KonvaEventObject } from "konva/lib/Node";
import type { Rect as KRect } from "konva/lib/shapes/Rect";
import type { Transformer as KTransformer } from "konva/lib/shapes/Transformer";
import useImage from "use-image";
import { ImageOff } from "lucide-react";
import { useStore } from "@/store";
import { useElementSize } from "@/hooks/useElementSize";
import { usePanZoom, type PanZoomController } from "./usePanZoom";
import { useDrawBlock } from "./useDrawBlock";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

export type CanvasController = PanZoomController;

function newBlockId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getActivePage(): { fileId: string; page: number } | null {
  const s = useStore.getState();
  if (!s.currentFileId) return null;
  const file = s.files.find((f) => f.id === s.currentFileId);
  if (!file) return null;
  return { fileId: file.id, page: file.currentPage ?? 1 };
}

export const ImageCanvas = forwardRef<CanvasController, object>(
  function ImageCanvas(_props, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<KStage>(null);
    const { width: cw, height: ch } = useElementSize(containerRef);

    const file = useStore((s) =>
      s.currentFileId ? s.files.find((f) => f.id === s.currentFileId) ?? null : null
    );
    const payload = file?.payload ?? null;
    const manualDrawMode = useStore((s) => s.manualDrawMode);
    const addBlock = useStore((s) => s.addBlock);

    const currentPage = file?.currentPage ?? 1;
    const pageState = useStore((s) => s.getPageState(file?.id ?? "", currentPage));
    const blocks = pageState.blocks;
    const selectionOrder = useStore((s) => s.getSelectionOrder(file?.id ?? "", currentPage));
    const selectedSet = useMemo(
      () => new Set(selectionOrder),
      [selectionOrder]
    );

    const imageSrc = useMemo(() => {
      if (!payload) return "";
      if (payload.objectUrl) return payload.objectUrl;
      if (payload.png_base64) return `data:image/png;base64,${payload.png_base64}`;
      return "";
    }, [payload]);
    const [image, status] = useImage(imageSrc);

    const { pan, scale, onWheel, onDragEnd, controller } = usePanZoom({
      fileId: file?.id ?? null,
      currentPage: file?.currentPage ?? null,
      containerWidth: cw,
      containerHeight: ch,
      imageWidth: payload?.width ?? null,
      imageHeight: payload?.height ?? null,
    });

    useImperativeHandle(ref, () => controller, [controller]);

    useKeyboardShortcuts();

    const isReady = !!image && status === "loaded" && cw > 0 && ch > 0;
    const showEmpty = !file;

    const blockRefs = useRef<Record<string, KRect>>({});
    const transformerRef = useRef<KTransformer>(null);
    const dragStartPos = useRef<Record<string, { x: number; y: number }>>({});

    const registerBlockRef = useCallback((id: string, node: KRect | null) => {
      if (node) blockRefs.current[id] = node;
      else delete blockRefs.current[id];
    }, []);

    useEffect(() => {
      const transformer = transformerRef.current;
      if (!transformer) return;
      const nodes = manualDrawMode
        ? (selectionOrder
            .map((id) => blockRefs.current[id])
            .filter(Boolean) as KRect[])
        : [];
      transformer.nodes(nodes);
      transformer.getLayer()?.batchDraw();
    }, [selectionOrder, manualDrawMode]);

    const handleBlockMouseDown = useCallback(
      (e: KonvaEventObject<MouseEvent>) => {
        e.cancelBubble = true;
        const blockId = e.target.id();
        if (!blockId) return;
        const ctx = getActivePage();
        if (!ctx) return;
        const { fileId, page } = ctx;
        const isMulti = e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey;
        const order = useStore.getState().getSelectionOrder(fileId, page);
        const already = order.includes(blockId);

        if (isMulti) {
          if (already) {
            useStore.getState().removeFromSelection(fileId, page, blockId);
          } else {
            useStore.getState().pushSelection(fileId, page, blockId);
          }
        } else if (!already) {
          useStore.getState().clearSelection(fileId, page);
          useStore.getState().pushSelection(fileId, page, blockId);
        }
        // Already selected, no multi-key: leave selection intact so a group drag
        // can begin from any member of the group.
      },
      []
    );

    const handleBlockTransformEnd = useCallback((e: KonvaEventObject<Event>) => {
      const ctx = getActivePage();
      if (!ctx) return;
      const node = e.target as KRect;
      const blockId = node.id();
      if (!blockId) return;
      useStore.getState().updateBlock(ctx.fileId, ctx.page, blockId, {
        x: node.x(),
        y: node.y(),
        w: node.width() * node.scaleX(),
        h: node.height() * node.scaleY(),
      });
      node.scaleX(1);
      node.scaleY(1);
    }, []);

    const handleBlockDragStart = useCallback((e: KonvaEventObject<DragEvent>) => {
      const ctx = getActivePage();
      if (!ctx) return;
      const blockId = (e.target as KRect).id();
      const order = useStore.getState().getSelectionOrder(ctx.fileId, ctx.page);
      if (!order.includes(blockId)) return;
      dragStartPos.current = {};
      order.forEach((id) => {
        const node = blockRefs.current[id];
        if (node) dragStartPos.current[id] = { x: node.x(), y: node.y() };
      });
    }, []);

    const handleBlockDragMove = useCallback((e: KonvaEventObject<DragEvent>) => {
      const ctx = getActivePage();
      if (!ctx) return;
      const dragged = e.target as KRect;
      const blockId = dragged.id();
      const start = dragStartPos.current[blockId];
      if (!start) return;
      const dx = dragged.x() - start.x;
      const dy = dragged.y() - start.y;
      const order = useStore.getState().getSelectionOrder(ctx.fileId, ctx.page);
      order.forEach((id) => {
        if (id === blockId) return;
        const node = blockRefs.current[id];
        const sp = dragStartPos.current[id];
        if (!node || !sp) return;
        node.x(sp.x + dx);
        node.y(sp.y + dy);
      });
    }, []);

    const handleBlockDragEnd = useCallback((e: KonvaEventObject<DragEvent>) => {
      const ctx = getActivePage();
      if (!ctx) return;
      const blockId = (e.target as KRect).id();
      const order = useStore.getState().getSelectionOrder(ctx.fileId, ctx.page);
      if (!order.includes(blockId)) {
        dragStartPos.current = {};
        return;
      }
      order.forEach((id) => {
        const node = blockRefs.current[id];
        if (!node) return;
        useStore.getState().updateBlock(ctx.fileId, ctx.page, id, {
          x: node.x(),
          y: node.y(),
        });
      });
      dragStartPos.current = {};
    }, []);

    const { drawState, handlers } = useDrawBlock({
      stageRef,
      manualDrawMode,
      onBlockCreated: ({ x, y, w, h }) => {
        if (!file) return;
        addBlock(file.id, file.currentPage ?? 1, {
          id: newBlockId(),
          x,
          y,
          w,
          h,
          articleId: null,
          articleOrder: null,
        });
      },
    });

    const onStageMouseDown = useCallback(
      (e: KonvaEventObject<MouseEvent>) => {
        handlers.onMouseDown(e);
        if (!manualDrawMode) return;
        if (e.target !== e.target.getStage()) return;
        const ctx = getActivePage();
        if (!ctx) return;
        useStore.getState().clearSelection(ctx.fileId, ctx.page);
      },
      [handlers.onMouseDown, manualDrawMode]
    );

    const rubberBand =
      drawState.kind === "drawing"
        ? {
            x: Math.min(drawState.startX, drawState.curX),
            y: Math.min(drawState.startY, drawState.curY),
            w: Math.abs(drawState.curX - drawState.startX),
            h: Math.abs(drawState.curY - drawState.startY),
          }
        : null;

    return (
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-hidden"
      >
        {cw > 0 && ch > 0 && (
          <Stage
            ref={stageRef}
            width={cw}
            height={ch}
            x={pan.x}
            y={pan.y}
            scaleX={scale}
            scaleY={scale}
            draggable={isReady && !manualDrawMode}
            onWheel={onWheel}
            onDragEnd={onDragEnd}
            onMouseDown={onStageMouseDown}
            onMouseMove={handlers.onMouseMove}
            onMouseUp={handlers.onMouseUp}
            style={{ cursor: manualDrawMode ? "crosshair" : undefined }}
          >
            <Layer listening={false}>
              {isReady && <KImage image={image} />}
            </Layer>
            <Layer>
              {rubberBand && (
                <Rect
                  x={rubberBand.x}
                  y={rubberBand.y}
                  width={rubberBand.w}
                  height={rubberBand.h}
                  stroke="#3b82f6"
                  strokeWidth={1 / scale}
                  dash={[6 / scale, 4 / scale]}
                  fill="rgba(59,130,246,0.08)"
                  listening={false}
                />
              )}
              {blocks.map((block) => (
                <BlockRect
                  key={block.id}
                  block={block}
                  isSelected={manualDrawMode && selectedSet.has(block.id)}
                  scale={scale}
                  interactive={manualDrawMode}
                  registerRef={registerBlockRef}
                  onMouseDown={handleBlockMouseDown}
                  onTransformEnd={handleBlockTransformEnd}
                  onDragStart={handleBlockDragStart}
                  onDragMove={handleBlockDragMove}
                  onDragEnd={handleBlockDragEnd}
                />
              ))}
              {manualDrawMode && (
                <Transformer
                  ref={transformerRef}
                  rotateEnabled={false}
                  keepRatio={false}
                  flipEnabled={false}
                  borderStroke="#2563eb"
                  anchorFill="#2563eb"
                  anchorStroke="#ffffff"
                  anchorSize={8}
                  boundBoxFunc={(oldBox, newBox) => {
                    const MIN = 16;
                    if (Math.abs(newBox.width) < MIN || Math.abs(newBox.height) < MIN) {
                      return oldBox;
                    }
                    return newBox;
                  }}
                />
              )}
            </Layer>
          </Stage>
        )}

        {showEmpty && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-3 text-foreground-subtle">
              <ImageOff className="h-9 w-9 opacity-60" strokeWidth={1.4} />
              <div className="text-sm">将扫描件拖入此处，或使用顶栏「添加文件」</div>
              <div className="font-mono text-xs">
                支持 PDF · PNG · JPG · TIFF · BMP
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
);
