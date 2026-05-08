import type { StateCreator } from "zustand";
import type { FileViewSlice } from "./fileViewSlice";
import type { QueueSlice } from "./queueSlice";

const MIN_ZOOM_PERCENT = 1;
const MAX_ZOOM_PERCENT = 800;

export interface UiSlice {
  statusText: string;
  setStatusText: (statusText: string) => void;
}

export const clampZoomPercent = (zoomPercent: number): number =>
  Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, zoomPercent));

export const createUiSlice: StateCreator<
  QueueSlice & UiSlice & FileViewSlice,
  [["zustand/immer", never]],
  [],
  UiSlice
> = (set) => ({
  statusText: "就绪",
  setStatusText: (statusText) =>
    set((state) => {
      state.statusText = statusText;
    }),
});
