import type { StateCreator } from "zustand";
import type { FileViewSlice } from "./fileViewSlice";
import type { QueueSlice } from "./queueSlice";
import type { PageStateSlice } from "./pageStateSlice";
import type { SelectionSlice } from "./selectionSlice";
import type { SettingsSlice } from "./settingsSlice";

const MIN_ZOOM_PERCENT = 1;
const MAX_ZOOM_PERCENT = 800;

export interface UiSlice {
  statusText: string;
  queueCollapsed: boolean;
  highlightedArticleId: string | null;
  setStatusText: (statusText: string) => void;
  toggleQueueCollapsed: () => void;
  setQueueCollapsed: (collapsed: boolean) => void;
  setHighlightedArticleId: (articleId: string | null) => void;
}

export const clampZoomPercent = (zoomPercent: number): number =>
  Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, zoomPercent));

export const createUiSlice: StateCreator<
  QueueSlice &
    UiSlice &
    FileViewSlice &
    PageStateSlice &
    SelectionSlice &
    SettingsSlice,
  [["zustand/immer", never]],
  [],
  UiSlice
> = (set) => ({
  statusText: "就绪",
  queueCollapsed: false,
  highlightedArticleId: null,
  setStatusText: (statusText) =>
    set((state) => {
      state.statusText = statusText;
    }),
  toggleQueueCollapsed: () =>
    set((state) => {
      state.queueCollapsed = !state.queueCollapsed;
    }),
  setQueueCollapsed: (collapsed) =>
    set((state) => {
      state.queueCollapsed = collapsed;
    }),
  setHighlightedArticleId: (articleId) =>
    set((state) => {
      state.highlightedArticleId = articleId;
    }),
});
