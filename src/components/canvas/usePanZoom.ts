import { useCallback, useEffect, useMemo, useRef } from "react";
import type { KonvaEventObject } from "konva/lib/Node";
import { useStore } from "@/store";
import { DEFAULT_FILE_VIEW } from "@/store/fileViewSlice";
import { clampZoomPercent } from "@/store/uiSlice";

const SCALE_FACTOR = 1.15;
const FIT_PADDING = 0.94;

export interface PanZoomController {
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  setPercent: (p: number) => void;
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
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      applyZoom(
        stateRef.current.scale * Math.pow(SCALE_FACTOR, direction),
        pointer
      );
    },
    [applyZoom]
  );

  const onDragEnd = useCallback(
    (e: KonvaEventObject<DragEvent>) => {
      const target = e.target;
      const fid = stateRef.current.fileId;
      if (!fid) return;
      setFilePan(fid, target.x(), target.y());
    },
    [setFilePan]
  );

  const controller = useMemo<PanZoomController>(
    () => ({
      fit,
      zoomIn: () => zoomBy(SCALE_FACTOR),
      zoomOut: () => zoomBy(1 / SCALE_FACTOR),
      setPercent,
    }),
    [fit, zoomBy, setPercent]
  );

  return { pan, scale, onWheel, onDragEnd, controller };
}
