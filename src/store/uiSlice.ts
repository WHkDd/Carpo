import type { StateCreator } from "zustand";
import type { QueueSlice } from "./queueSlice";

const MIN_ZOOM_PERCENT = 1;
const MAX_ZOOM_PERCENT = 800;

export interface UiSlice {
  zoomPercent: number;
  statusText: string;
  setZoomPercent: (zoomPercent: number) => void;
  setStatusText: (statusText: string) => void;
}

export const clampZoomPercent = (zoomPercent: number): number =>
  Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, zoomPercent));

export const createUiSlice: StateCreator<
  QueueSlice & UiSlice,
  [["zustand/immer", never]],
  [],
  UiSlice
> = (set) => ({
  zoomPercent: 100,
  statusText: "就绪",
  setZoomPercent: (zoomPercent) =>
    set((state) => {
      state.zoomPercent = clampZoomPercent(zoomPercent);
    }),
  setStatusText: (statusText) =>
    set((state) => {
      state.statusText = statusText;
    }),
});
