import { useCallback, useEffect, useMemo, useRef } from "react";
import type { KonvaEventObject } from "konva/lib/Node";
import { useStore } from "@/store";
import { DEFAULT_FILE_VIEW } from "@/store/fileViewSlice";
import { clampZoomPercent } from "@/store/uiSlice";

const SCALE_FACTOR = 1.15;
const FIT_PADDING = 0.94;
const WHEEL_ZOOM_SENSITIVITY = 0.002;

export function wheelDeltaPixels(
  delta: number,
  deltaMode: number,
  pageSize: number
): number {
  // WheelEvent constants are 1 (line) and 2 (page). Keep the helper free of a
  // browser-global read so it remains usable during SSR and unit tests.
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * pageSize;
  return delta;
}

export function wheelZoomFactor(deltaY: number): number {
  // Bound a single malformed/page-mode event while preserving the continuous
  // response of trackpad pinch and high-resolution mouse wheels.
  return Math.min(2, Math.max(0.5, Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY)));
}

/** A rect in canvas space — the page's native pixel coordinates, which is
 *  what block rects and layout bboxes are stored in. */
export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The same rect after projection into the stage container's screen space. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Projects a canvas-space rect through the stage transform: `screen = canvas
 *  * scale + pan`. Pure so the reveal maths stay unit-testable outside the
 *  hook. */
export function projectRect(
  rect: CanvasRect,
  scale: number,
  pan: { x: number; y: number }
): ScreenRect {
  const left = rect.x * scale + pan.x;
  const top = rect.y * scale + pan.y;
  return {
    left,
    top,
    right: (rect.x + rect.width) * scale + pan.x,
    bottom: (rect.y + rect.height) * scale + pan.y,
  };
}

/** True when the whole rect lies inside the 0..cw × 0..ch viewport. A rect
 *  flush against an edge still counts — it is fully readable. */
export function isFullyVisible(
  rect: ScreenRect,
  viewportWidth: number,
  viewportHeight: number
): boolean {
  return (
    rect.left >= 0 &&
    rect.top >= 0 &&
    rect.right <= viewportWidth &&
    rect.bottom <= viewportHeight
  );
}

/** The pan that puts the rect's centre at the viewport's centre, at the
 *  current zoom (the zoom level itself is never touched — changing it would
 *  make the user lose their bearings). Centring rather than minimal-edge
 *  translation is deliberate: this pan fires on keyboard focus, and a
 *  centred block reads as "here", not as "somewhere near the edge". */
export function panToCenterRect(
  rect: CanvasRect,
  scale: number,
  viewportWidth: number,
  viewportHeight: number
): { x: number; y: number } {
  return {
    x: viewportWidth / 2 - (rect.x + rect.width / 2) * scale,
    y: viewportHeight / 2 - (rect.y + rect.height / 2) * scale,
  };
}

export interface PanZoomController {
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  setPercent: (p: number) => void;
  /** Bring a canvas-space rect into view. Fully visible → no-op (repeated
   *  calls are idempotent); otherwise pan so the rect is centred, keeping the
   *  current zoom. The jump is instant — this tracks keyboard focus, and an
   *  animated pan under a held-down Tab key would smear (ship-readiness #43). */
  revealRect: (x: number, y: number, w: number, h: number) => void;
}

export interface UsePanZoomArgs {
  fileId: string | null;
  currentPage: number | null;
  containerWidth: number;
  containerHeight: number;
  imageWidth: number | null;
  imageHeight: number | null;
}

export function usePanZoom(args: UsePanZoomArgs) {
  const {
    fileId,
    currentPage,
    containerWidth: cw,
    containerHeight: ch,
    imageWidth: iw,
    imageHeight: ih,
  } = args;

  const view = useStore((s) =>
    fileId ? s.fileViews[fileId] ?? DEFAULT_FILE_VIEW : DEFAULT_FILE_VIEW
  );
  const setFileView = useStore((s) => s.setFileView);
  const setFileZoomAndPan = useStore((s) => s.setFileZoomAndPan);
  const setFilePan = useStore((s) => s.setFilePan);

  const scale = view.zoomPercent / 100;
  const pan = { x: view.panX, y: view.panY };

  // Latest values for handler closures (avoids stale captures without
  // re-creating handlers on every render).
  const stateRef = useRef({ scale, pan, fileId, view });
  stateRef.current = { scale, pan, fileId, view };

  const computeFit = useCallback(
    (
      iiw: number,
      iih: number,
      iccw: number,
      icch: number
    ): { percent: number; panX: number; panY: number } => {
      const fitScale = Math.min(iccw / iiw, icch / iih) * FIT_PADDING;
      const percent = clampZoomPercent(Math.round(fitScale * 100));
      const finalScale = percent / 100;
      return {
        percent,
        panX: (iccw - iiw * finalScale) / 2,
        panY: (icch - iih * finalScale) / 2,
      };
    },
    []
  );

  const lastFitSigRef = useRef<string | null>(null);

  // Fit-driver effect.
  //
  // Three triggers:
  //   1. New file (no entry in fileViews yet) → seed fit.
  //   2. isFit=true → re-fit on every (page, dims, container) change.
  //   3. isFit=false → never auto-fit; respect stored zoom + pan.
  //
  // Tracking lastFitSigRef avoids repeated writes for the same fit context.
  useEffect(() => {
    if (!fileId || !iw || !ih || cw === 0 || ch === 0) return;

    const sig = `${fileId}::${currentPage ?? 0}::${iw}x${ih}::${cw}x${ch}`;
    const stored = useStore.getState().fileViews[fileId];

    if (!stored) {
      const next = computeFit(iw, ih, cw, ch);
      setFileView(fileId, {
        zoomPercent: next.percent,
        panX: next.panX,
        panY: next.panY,
        isFit: true,
      });
      lastFitSigRef.current = sig;
      return;
    }

    if (stored.isFit && lastFitSigRef.current !== sig) {
      const next = computeFit(iw, ih, cw, ch);
      setFileView(fileId, {
        zoomPercent: next.percent,
        panX: next.panX,
        panY: next.panY,
        isFit: true,
      });
      lastFitSigRef.current = sig;
    }
  }, [fileId, currentPage, iw, ih, cw, ch, computeFit, setFileView]);

  const fit = useCallback(() => {
    if (!fileId || !iw || !ih || cw === 0 || ch === 0) return;
    const next = computeFit(iw, ih, cw, ch);
    setFileView(fileId, {
      zoomPercent: next.percent,
      panX: next.panX,
      panY: next.panY,
      isFit: true,
    });
    lastFitSigRef.current = `${fileId}::${currentPage ?? 0}::${iw}x${ih}::${cw}x${ch}`;
  }, [fileId, currentPage, iw, ih, cw, ch, computeFit, setFileView]);

  const applyZoom = useCallback(
    (nextScale: number, anchor: { x: number; y: number }) => {
      const { scale: curScale, pan: curPan, fileId: fid } = stateRef.current;
      if (!fid || curScale === 0) return;
      const percent = clampZoomPercent(Math.round(nextScale * 100));
      const finalScale = percent / 100;
      const ratio = finalScale / curScale;
      const nextPan = {
        x: anchor.x - (anchor.x - curPan.x) * ratio,
        y: anchor.y - (anchor.y - curPan.y) * ratio,
      };
      stateRef.current = {
        ...stateRef.current,
        scale: finalScale,
        pan: nextPan,
        view: {
          ...stateRef.current.view,
          zoomPercent: percent,
          panX: nextPan.x,
          panY: nextPan.y,
          isFit: false,
        },
      };
      setFileZoomAndPan(fid, percent, nextPan.x, nextPan.y);
    },
    [setFileZoomAndPan]
  );

  const zoomBy = useCallback(
    (factor: number) => {
      if (cw === 0 || ch === 0) return;
      applyZoom(stateRef.current.scale * factor, { x: cw / 2, y: ch / 2 });
    },
    [applyZoom, cw, ch]
  );

  const setPercent = useCallback(
    (p: number) => {
      if (!fileId) return;
      if (cw === 0 || ch === 0) {
        setFileZoomAndPan(
          fileId,
          clampZoomPercent(p),
          stateRef.current.pan.x,
          stateRef.current.pan.y
        );
        return;
      }
      applyZoom(p / 100, { x: cw / 2, y: ch / 2 });
    },
    [applyZoom, cw, ch, fileId, setFileZoomAndPan]
  );

  const onWheel = useCallback(
    (e: KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const stage = e.target.getStage();
      if (!stage) return;
      const event = e.evt;
      const deltaX = wheelDeltaPixels(event.deltaX, event.deltaMode, cw);
      const deltaY = wheelDeltaPixels(event.deltaY, event.deltaMode, ch);

      if (event.ctrlKey || event.metaKey) {
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        applyZoom(stateRef.current.scale * wheelZoomFactor(deltaY), pointer);
        return;
      }

      const fid = stateRef.current.fileId;
      if (!fid) return;
      const horizontal = event.shiftKey && deltaX === 0 ? deltaY : deltaX;
      const vertical = event.shiftKey && deltaX === 0 ? 0 : deltaY;
      const nextPan = {
        x: stateRef.current.pan.x - horizontal,
        y: stateRef.current.pan.y - vertical,
      };
      stateRef.current = {
        ...stateRef.current,
        pan: nextPan,
        view: {
          ...stateRef.current.view,
          panX: nextPan.x,
          panY: nextPan.y,
          isFit: false,
        },
      };
      setFilePan(fid, nextPan.x, nextPan.y);
    },
    [applyZoom, ch, cw, setFilePan]
  );

  const onDragEnd = useCallback(
    (e: KonvaEventObject<DragEvent>) => {
      // Konva drag events bubble — ignore drags that originated on a child
      // (block Rect, Transformer anchor) so we only commit pan when the Stage
      // itself was dragged.
      const stage = e.target.getStage();
      if (!stage || e.target !== stage) return;
      const fid = stateRef.current.fileId;
      if (!fid) return;
      const nextPan = { x: stage.x(), y: stage.y() };
      stateRef.current = {
        ...stateRef.current,
        pan: nextPan,
        view: {
          ...stateRef.current.view,
          panX: nextPan.x,
          panY: nextPan.y,
          isFit: false,
        },
      };
      setFilePan(fid, nextPan.x, nextPan.y);
    },
    [setFilePan]
  );

  const revealRect = useCallback(
    (x: number, y: number, w: number, h: number) => {
      if (cw === 0 || ch === 0) return;
      const fid = stateRef.current.fileId;
      if (!fid) return;
      // Read the committed view instead of `stateRef`, which only mirrors the
      // last *render*. Unlike wheel and drag, this runs from an effect, and the
      // fit-driver effect above may have written a fresh zoom + pan earlier in
      // the same flush — React has not re-rendered yet, so `stateRef` would
      // still hold the pre-fit transform. Centring against a transform that no
      // longer exists lands the block in the wrong place *and* clears `isFit`
      // for what was only a container resize.
      const current = useStore.getState().fileViews[fid] ?? DEFAULT_FILE_VIEW;
      const curScale = current.zoomPercent / 100;
      if (curScale <= 0) return;
      const rect = { x, y, width: w, height: h };
      const screen = projectRect(rect, curScale, {
        x: current.panX,
        y: current.panY,
      });
      if (isFullyVisible(screen, cw, ch)) return;
      const nextPan = panToCenterRect(rect, curScale, cw, ch);
      stateRef.current = {
        ...stateRef.current,
        scale: curScale,
        pan: nextPan,
        view: {
          ...current,
          panX: nextPan.x,
          panY: nextPan.y,
          isFit: false,
        },
      };
      setFilePan(fid, nextPan.x, nextPan.y);
    },
    [cw, ch, setFilePan]
  );

  const controller = useMemo<PanZoomController>(
    () => ({
      fit,
      zoomIn: () => zoomBy(SCALE_FACTOR),
      zoomOut: () => zoomBy(1 / SCALE_FACTOR),
      setPercent,
      revealRect,
    }),
    [fit, zoomBy, setPercent, revealRect]
  );

  return { pan, scale, onWheel, onDragEnd, controller };
}
