import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KonvaEventObject } from "konva/lib/Node";
import { useStore } from "@/store";
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
  containerWidth: number;
  containerHeight: number;
  imageWidth: number | null;
  imageHeight: number | null;
  fitKey: string | null;
}

export function usePanZoom(args: UsePanZoomArgs) {
  const { containerWidth: cw, containerHeight: ch, imageWidth: iw, imageHeight: ih, fitKey } = args;
  const zoomPercent = useStore((s) => s.zoomPercent);
  const setZoomPercent = useStore((s) => s.setZoomPercent);

  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panRef = useRef(pan);
  panRef.current = pan;

  const lastFitKeyRef = useRef<string | null>(null);
  const scale = zoomPercent / 100;

  const fit = useCallback(() => {
    if (!iw || !ih || cw === 0 || ch === 0) return;
    const fitScale = Math.min(cw / iw, ch / ih) * FIT_PADDING;
    const percent = clampZoomPercent(Math.round(fitScale * 100));
    const finalScale = percent / 100;
    setPan({
      x: (cw - iw * finalScale) / 2,
      y: (ch - ih * finalScale) / 2,
    });
    setZoomPercent(percent);
  }, [iw, ih, cw, ch, setZoomPercent]);

  const applyZoom = useCallback(
    (nextScale: number, anchor: { x: number; y: number }) => {
      if (scale === 0) return;
      const percent = clampZoomPercent(Math.round(nextScale * 100));
      const finalScale = percent / 100;
      const ratio = finalScale / scale;
      const cur = panRef.current;
      setPan({
        x: anchor.x - (anchor.x - cur.x) * ratio,
        y: anchor.y - (anchor.y - cur.y) * ratio,
      });
      setZoomPercent(percent);
    },
    [scale, setZoomPercent]
  );

  const zoomBy = useCallback(
    (factor: number) => {
      if (cw === 0 || ch === 0) return;
      applyZoom(scale * factor, { x: cw / 2, y: ch / 2 });
    },
    [applyZoom, scale, cw, ch]
  );

  const setPercent = useCallback(
    (p: number) => {
      if (cw === 0 || ch === 0) {
        setZoomPercent(p);
        return;
      }
      applyZoom(p / 100, { x: cw / 2, y: ch / 2 });
    },
    [applyZoom, cw, ch, setZoomPercent]
  );

  // Auto-fit when a different file/size becomes ready
  useEffect(() => {
    if (!fitKey || !iw || !ih || cw === 0 || ch === 0) return;
    if (lastFitKeyRef.current === fitKey) return;
    lastFitKeyRef.current = fitKey;
    fit();
  }, [fitKey, iw, ih, cw, ch, fit]);

  const onWheel = useCallback(
    (e: KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const stage = e.target.getStage();
      if (!stage) return;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      applyZoom(scale * Math.pow(SCALE_FACTOR, direction), pointer);
    },
    [applyZoom, scale]
  );

  const onDragEnd = useCallback((e: KonvaEventObject<DragEvent>) => {
    const target = e.target;
    setPan({ x: target.x(), y: target.y() });
  }, []);

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
