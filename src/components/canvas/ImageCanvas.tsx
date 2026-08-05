import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Stage, Layer, Image as KImage, Rect, Transformer } from "react-konva";
import { BlockRect } from "./BlockRect";
import { SelectionOrderLabel } from "./SelectionOrderLabel";
import type { Stage as KStage } from "konva/lib/Stage";
import type { KonvaEventObject } from "konva/lib/Node";
import type { Rect as KRect } from "konva/lib/shapes/Rect";
import type { Transformer as KTransformer } from "konva/lib/shapes/Transformer";
import useImage from "use-image";
import { ImageOff } from "lucide-react";
import { useStore } from "@/store";
import { useT } from "@/i18n";
import type { Block } from "@/store/pageStateSlice";
import { useElementSize } from "@/hooks/useElementSize";
import { subscribeArticleColorTokens } from "@/lib/article-color-token";
import { usePanZoom, type PanZoomController } from "./usePanZoom";
import { useDrawBlock } from "./useDrawBlock";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

export type CanvasController = PanZoomController;

const CONTEXT_MENU_W = 160;
const CONTEXT_MENU_H = 80;

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
    const t = useT();
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
    const docState = useStore((s) =>
      file?.id ? s.getDocumentState(file.id) : null
    );
    const articleNumById = useMemo(() => {
      const map = new Map<string, number>();
      if (docState?.articles) {
        for (const a of docState.articles) map.set(a.id, a.num);
      }
      return map;
    }, [docState]);
    const fileSelectionOrder = useStore((s) =>
      file?.id ? s.selectionOrders[file.id] ?? null : null
    );
    const selectionOrder = useMemo(
      () =>
        (fileSelectionOrder ?? [])
          .filter((ref) => ref.page === currentPage)
          .map((ref) => ref.blockId),
      [currentPage, fileSelectionOrder]
    );
    const selectionIndexById = useMemo(() => {
      const map = new Map<string, number>();
      for (const [index, ref] of (fileSelectionOrder ?? []).entries()) {
        if (ref.page === currentPage) map.set(ref.blockId, index + 1);
      }
      return map;
    }, [currentPage, fileSelectionOrder]);
    const editingBlockId = useStore((s) =>
      file?.id ? s.getEditingBlockId(file.id, currentPage) : null
    );
    const selectedArticleIds = useStore((s) => s.selectedArticleIds);
    const recognitionMode = useStore((s) => s.recognitionMode);
    const highlightedArticleSet = useMemo(
      () => new Set(recognitionMode === "grouped" ? selectedArticleIds : []),
      [recognitionMode, selectedArticleIds]
    );
    const isHighlighted = useCallback(
      (articleId: string | null) => {
        if (!articleId || highlightedArticleSet.size === 0) return false;
        return highlightedArticleSet.has(articleId);
      },
      [highlightedArticleSet]
    );
    const isBlockInteractive = useCallback(
      (block: Block) => {
        if (!manualDrawMode) return false;
        if (!block.articleId) return true;
        return block.id === editingBlockId || isHighlighted(block.articleId);
      },
      [editingBlockId, isHighlighted, manualDrawMode]
    );
    const selectedSet = useMemo(
      () => new Set(selectionOrder),
      [selectionOrder]
    );
    const blockById = useMemo(() => {
      const map = new Map<string, (typeof blocks)[number]>();
      for (const block of blocks) map.set(block.id, block);
      return map;
    }, [blocks]);

    const imageSrc = payload?.objectUrl ?? "";
    const [image, status] = useImage(imageSrc);

    const { pan, scale, onWheel, onDragEnd, controller } = usePanZoom({
      fileId: file?.id ?? null,
      currentPage: file?.currentPage ?? null,
      containerWidth: cw,
      containerHeight: ch,
      imageWidth: payload?.width ?? null,
      imageHeight: payload?.height ?? null,
    });

    const isReady = !!image && status === "loaded" && cw > 0 && ch > 0;
    const showEmpty = !file;

    const blockRefs = useRef<Record<string, KRect>>({});
    const transformerRef = useRef<KTransformer>(null);
    const dragStartPos = useRef<Record<string, { x: number; y: number }>>({});

    const [ctxMenu, setCtxMenu] = useState<{
      x: number;
      y: number;
      blockId: string;
    } | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState<{
      ids: string[];
    } | null>(null);
    const [colorVersion, setColorVersion] = useState(0);
    const [resizeTargetId, setResizeTargetId] = useState<string | null>(null);

    useImperativeHandle(ref, () => controller, [controller]);

    useEffect(() => {
      return subscribeArticleColorTokens(() => {
        setColorVersion((version) => version + 1);
      });
    }, []);

    const performDelete = useCallback((ids: string[]) => {
      const ctx = getActivePage();
      if (!ctx || ids.length === 0) return;
      const { fileId, page } = ctx;
      const s = useStore.getState();
      s.removeBlocks(fileId, page, ids);
    }, []);

    const requestDelete = useCallback(
      (ids: string[]) => {
        const uniqueIds = Array.from(new Set(ids)).filter((id) =>
          blockById.has(id)
        );
        if (uniqueIds.length === 0) return;
        if (uniqueIds.length > 5) {
          setDeleteConfirm({ ids: uniqueIds });
          return;
        }
        performDelete(uniqueIds);
      },
      [blockById, performDelete]
    );

    const requestDeleteSelected = useCallback(() => {
      const ctx = getActivePage();
      if (!ctx) return;
      const s = useStore.getState();
      const order = [...s.getSelectionOrder(ctx.fileId, ctx.page)];
      if (order.length > 0) {
        requestDelete(order);
        return;
      }
      const editingId = s.getEditingBlockId(ctx.fileId, ctx.page);
      if (editingId) {
        requestDelete([editingId]);
      }
    }, [requestDelete]);

    useKeyboardShortcuts({
      enabled: !deleteConfirm,
      onDeleteSelected: requestDeleteSelected,
    });

    const contextTargetIds = useMemo(() => {
      if (!ctxMenu || !blockById.has(ctxMenu.blockId)) return [];
      return [ctxMenu.blockId];
    }, [blockById, ctxMenu]);

    // Live refs so the context-menu listener (mounted once per stage) can
    // read the latest geometry / block index without resubscribing on every
    // pan, zoom, resize, or block edit.
    const cwRef = useRef(cw);
    const chRef = useRef(ch);
    const blockByIdRef = useRef(blockById);
    useEffect(() => {
      cwRef.current = cw;
      chRef.current = ch;
      blockByIdRef.current = blockById;
    });

    const stageMounted = cw > 0 && ch > 0;
    useEffect(() => {
      if (!stageMounted) return;
      const stage = stageRef.current;
      if (!stage) return;
      const container = stage.container();
      if (!container) return;

      const onContextMenu = (e: MouseEvent) => {
        if (!useStore.getState().manualDrawMode) return;
        e.preventDefault();

        const rect = container.getBoundingClientRect();
        const stageX = e.clientX - rect.left;
        const stageY = e.clientY - rect.top;
        const shape = stage.getIntersection({ x: stageX, y: stageY });
        if (!shape) return;

        const blockId = shape.id();
        if (!blockId || !blockByIdRef.current.has(blockId)) return;

        setCtxMenu({
          x: Math.min(stageX, Math.max(0, cwRef.current - CONTEXT_MENU_W)),
          y: Math.min(stageY, Math.max(0, chRef.current - CONTEXT_MENU_H)),
          blockId,
        });
      };

      const onClick = () => setCtxMenu(null);

      container.addEventListener("contextmenu", onContextMenu);
      window.addEventListener("click", onClick);
      return () => {
        container.removeEventListener("contextmenu", onContextMenu);
        window.removeEventListener("click", onClick);
      };
    }, [stageMounted]);

    const handleCtxDelete = useCallback(() => {
      requestDelete(contextTargetIds);
      setCtxMenu(null);
    }, [contextTargetIds, requestDelete]);

    const registerBlockRef = useCallback((id: string, node: KRect | null) => {
      if (node) blockRefs.current[id] = node;
      else delete blockRefs.current[id];
    }, []);

    useEffect(() => {
      if (!manualDrawMode || editingBlockId) {
        setResizeTargetId(null);
        return;
      }
      if (selectionOrder.length === 0) {
        setResizeTargetId(null);
        return;
      }
      setResizeTargetId((current) =>
        current && selectionOrder.includes(current)
          ? current
          : selectionOrder[selectionOrder.length - 1]!
      );
    }, [editingBlockId, manualDrawMode, selectionOrder]);

    useEffect(() => {
      const transformer = transformerRef.current;
      if (!transformer) return;
      if (!manualDrawMode) {
        transformer.nodes([]);
        transformer.getLayer()?.batchDraw();
        return;
      }
      const targetId =
        editingBlockId ??
        (resizeTargetId && selectionOrder.includes(resizeTargetId)
          ? resizeTargetId
          : selectionOrder[selectionOrder.length - 1]);
      const node = targetId ? blockRefs.current[targetId] : null;
      const nodes = node ? [node] : [];
      transformer.nodes(nodes);
      transformer.getLayer()?.batchDraw();
    }, [selectionOrder, manualDrawMode, editingBlockId, resizeTargetId]);

    const handleBlockMouseDown = useCallback(
      (e: KonvaEventObject<MouseEvent>) => {
        e.cancelBubble = true;
        const blockId = e.target.id();
        if (!blockId) return;
        const ctx = getActivePage();
        if (!ctx) return;
        const { fileId, page } = ctx;
        const s = useStore.getState();
        const ps = s.getPageState(fileId, page);
        const block = ps.blocks.find((b) => b.id === blockId);
        if (!block) return;
        const isMulti = e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey;

        if (block.articleId) {
          // Grouped blocks enter "edit mode" only — they never join the
          // selection draft, so their article identity is preserved across
          // resize/drag and Mark-as-Article never strips them.
          if (isMulti) return;
          s.clearSelection(fileId, page);
          s.setEditingBlock(fileId, { page, blockId });
          setResizeTargetId(null);
          return;
        }

        // Ungrouped block: existing selection flow, but exit any prior edit.
        s.setEditingBlock(fileId, null);
        const order = s.getSelectionOrder(fileId, page);
        const already = order.includes(blockId);

        if (isMulti) {
          if (already) {
            s.removeFromSelection(fileId, page, blockId);
            if (resizeTargetId === blockId) setResizeTargetId(null);
          } else {
            s.pushSelection(fileId, page, blockId);
            setResizeTargetId(blockId);
          }
        } else if (!already) {
          s.pushSelection(fileId, page, blockId);
          setResizeTargetId(blockId);
        } else {
          setResizeTargetId(blockId);
        }
        // Already selected, no multi-key: leave selection intact so a group drag
        // can begin from any member of the group. The clicked member becomes
        // the resize target so multi-selected blocks can still be adjusted
        // one by one instead of sharing a single group transformer.
      },
      [resizeTargetId]
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
      const node = e.target as KRect;
      const blockId = node.id();
      const order = useStore.getState().getSelectionOrder(ctx.fileId, ctx.page);
      if (!order.includes(blockId)) {
        // Single-block edit drag (e.g. a grouped block being repositioned).
        useStore.getState().updateBlock(ctx.fileId, ctx.page, blockId, {
          x: node.x(),
          y: node.y(),
        });
        dragStartPos.current = {};
        return;
      }
      order.forEach((id) => {
        const peer = blockRefs.current[id];
        if (!peer) return;
        useStore.getState().updateBlock(ctx.fileId, ctx.page, id, {
          x: peer.x(),
          y: peer.y(),
        });
      });
      dragStartPos.current = {};
    }, []);

    const { drawState, handlers: drawHandlers } = useDrawBlock({
      stageRef,
      manualDrawMode,
      onBlockCreated: ({ x, y, w, h }) => {
        if (!file) return;
        const page = file.currentPage ?? 1;
        const id = newBlockId();
        addBlock(file.id, page, {
          id,
          x,
          y,
          w,
          h,
          articleId: null,
          articleOrder: null,
        });
        useStore.getState().setEditingBlock(file.id, null);
        useStore.getState().pushSelection(file.id, page, id);
        setResizeTargetId(id);
      },
    });
    const {
      onMouseDown: onDrawMouseDown,
      onMouseMove: onDrawMouseMove,
      onMouseUp: onDrawMouseUp,
    } = drawHandlers;

    const onStageMouseDown = useCallback(
      (e: KonvaEventObject<MouseEvent>) => {
        // Clicking the empty canvas exits "edit mode" so the Transformer
        // handles around a previously-edited grouped block don't block the
        // user from drawing a new rubber-band selection nearby.
        if (e.target === e.target.getStage()) {
          const s = useStore.getState();
          if (s.manualDrawMode && s.currentFileId) {
            s.setEditingBlock(s.currentFileId, null);
          }
        }
        onDrawMouseDown(e);
      },
      [onDrawMouseDown]
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
            onMouseMove={onDrawMouseMove}
            onMouseUp={onDrawMouseUp}
            style={{ cursor: manualDrawMode ? "crosshair" : undefined }}
          >
            <Layer listening={false}>
              {isReady && <KImage image={image} />}
            </Layer>
            <Layer>
              {blocks.map((block) => (
                <BlockRect
                  key={block.id}
                  block={block}
                  isSelected={manualDrawMode && selectedSet.has(block.id)}
                  isEditing={manualDrawMode && block.id === editingBlockId}
                  scale={scale}
                  interactive={isBlockInteractive(block)}
                  articleNum={
                    block.articleId ? articleNumById.get(block.articleId) : undefined
                  }
                  isHighlighted={isHighlighted(block.articleId)}
                  colorVersion={colorVersion}
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
            <Layer listening={false}>
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
              {manualDrawMode &&
                selectionOrder.map((blockId) => {
                  const block = blockById.get(blockId);
                  if (!block) return null;
                  const order = selectionIndexById.get(blockId) ?? 0;
                  if (order <= 0) return null;
                  return (
                    <SelectionOrderLabel
                      key={`label-${blockId}`}
                      x={block.x}
                      y={block.y}
                      order={order}
                      colorVersion={colorVersion}
                    />
                  );
                })}
              {highlightedArticleSet.size > 0 &&
                blocks.map((block) => {
                  if (
                    !block.articleId ||
                    !highlightedArticleSet.has(block.articleId) ||
                    block.articleOrder == null
                  ) {
                    return null;
                  }
                  return (
                    <SelectionOrderLabel
                      key={`article-label-${block.id}`}
                      x={block.x}
                      y={block.y}
                      order={block.articleOrder}
                      colorVersion={colorVersion}
                    />
                  );
                })}
            </Layer>
          </Stage>
        )}

        {ctxMenu && (
          <div
            className="absolute z-50 min-w-[160px] overflow-hidden rounded-md border bg-popover py-1 text-popover-foreground shadow-lg"
            style={{
              left: ctxMenu.x,
              top: ctxMenu.y,
              borderColor: "hsl(var(--border))",
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-sm text-destructive hover:bg-surface-2"
              onClick={handleCtxDelete}
            >
              {t("canvas.deleteBlocks")}
            </button>
          </div>
        )}

        {deleteConfirm && (
          <div
            className="absolute inset-0 z-[60] grid place-items-center bg-black/10"
            role="presentation"
            onMouseDown={() => setDeleteConfirm(null)}
          >
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-blocks-title"
              aria-describedby="delete-blocks-desc"
              className="w-[320px] rounded-md border bg-popover p-4 shadow-xl"
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Escape") setDeleteConfirm(null);
              }}
            >
              <div
                id="delete-blocks-title"
                className="text-sm font-semibold text-foreground"
              >
                {t("canvas.deleteConfirmTitle")}
              </div>
              <div
                id="delete-blocks-desc"
                className="mt-2 text-sm text-foreground-muted"
              >
                {t("canvas.deleteConfirmBody", {
                  count: deleteConfirm.ids.length,
                })}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-md border px-3 py-1.5 text-sm text-foreground hover:bg-surface-2"
                  onClick={() => setDeleteConfirm(null)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:opacity-90"
                  autoFocus
                  onClick={() => {
                    performDelete(deleteConfirm.ids);
                    setDeleteConfirm(null);
                  }}
                >
                  {t("common.delete")}
                </button>
              </div>
            </div>
          </div>
        )}

        {showEmpty && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-3 text-foreground-subtle">
              <ImageOff className="h-9 w-9 opacity-60" strokeWidth={1.4} />
              <div className="text-sm">{t("canvas.dropHint")}</div>
              <div className="font-mono text-xs">{t("canvas.formats")}</div>
            </div>
          </div>
        )}
      </div>
    );
  }
);
