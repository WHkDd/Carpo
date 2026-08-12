import type { StateCreator } from "zustand";
import type { FileViewSlice } from "./fileViewSlice";
import type { QueueSlice } from "./queueSlice";
import type { PageStateSlice } from "./pageStateSlice";
import type { SelectionSlice } from "./selectionSlice";
import type { SettingsSlice } from "./settingsSlice";
import type { JobSlice } from "./jobSlice";
import { t } from "@/i18n";

const MIN_ZOOM_PERCENT = 1;
const MAX_ZOOM_PERCENT = 800;

/** Drag-resizable OCR text panel: bounded so neither section can collapse. */
export const OCR_PANEL_MIN_HEIGHT = 120;
export const OCR_PANEL_MAX_RESERVE = 200;
const DEFAULT_OCR_PANEL_HEIGHT = 280;

/** Top-level recognition workflow. `grouped` is the article / box-marking
 *  flow; `whole_file` is the page-by-page OCR flow with no marking tools. */
export type RecognitionMode = "grouped" | "whole_file";

export interface UiSlice {
  statusText: string;
  queueCollapsed: boolean;
  recognitionMode: RecognitionMode;
  /** Multi-select of articles in the right rail. Drives canvas highlighting
   *  (every selected article's blocks light up) and the OCR trigger's scope.
   *  Order is preserved for the eventual "last-clicked" cues but treated as
   *  a set elsewhere. */
  selectedArticleIds: string[];
  /** Pixel height of the OCR text panel in the right rail. The article list
   *  above it takes whatever vertical space is left. In-memory only — the
   *  user re-sets per session. */
  ocrPanelHeight: number;
  /** True while files are being dragged over the window. Drives the canvas
   *  drop-target overlay — without it, hovering a file over the window looks
   *  exactly like hovering it over dead space. */
  dropTargetActive: boolean;
  setStatusText: (statusText: string) => void;
  setDropTargetActive: (active: boolean) => void;
  toggleQueueCollapsed: () => void;
  setQueueCollapsed: (collapsed: boolean) => void;
  setRecognitionMode: (mode: RecognitionMode) => void;
  /** Replace the selection. Pass [] to clear. */
  setSelectedArticleIds: (articleIds: string[]) => void;
  /** Mouse-click semantics: bare click replaces, cmd/ctrl click toggles. */
  toggleArticleSelection: (articleId: string, additive: boolean) => void;
  clearArticleSelection: () => void;
  /** Set the OCR panel height. Caller is responsible for clamping; this is a
   *  raw setter so the drag handler can recompute bounds against the live
   *  rail height. */
  setOcrPanelHeight: (height: number) => void;
}

export const clampZoomPercent = (zoomPercent: number): number =>
  Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, zoomPercent));

export const createUiSlice: StateCreator<
  QueueSlice &
    UiSlice &
    FileViewSlice &
    PageStateSlice &
    SelectionSlice &
    SettingsSlice &
    JobSlice,
  [["zustand/immer", never]],
  [],
  UiSlice
> = (set) => ({
  statusText: t("common.ready"),
  queueCollapsed: false,
  recognitionMode: "grouped",
  selectedArticleIds: [],
  ocrPanelHeight: DEFAULT_OCR_PANEL_HEIGHT,
  dropTargetActive: false,
  setStatusText: (statusText) =>
    set((state) => {
      state.statusText = statusText;
    }),
  setDropTargetActive: (active) =>
    set((state) => {
      state.dropTargetActive = active;
    }),
  toggleQueueCollapsed: () =>
    set((state) => {
      state.queueCollapsed = !state.queueCollapsed;
    }),
  setQueueCollapsed: (collapsed) =>
    set((state) => {
      state.queueCollapsed = collapsed;
    }),
  setRecognitionMode: (mode) =>
    set((state) => {
      state.recognitionMode = mode;
      if (mode !== "whole_file") return;

      // Whole-file OCR is a pure browse flow: drop any transient drawing /
      // article-selection affordances so the right rail and canvas don't keep
      // showing grouped-mode state after the mode switch.
      state.manualDrawMode = false;
      state.selectedArticleIds = [];
      Object.keys(state.selectionOrders).forEach((fileId) => {
        state.selectionOrders[fileId] = [];
      });
      Object.keys(state.editingBlock).forEach((fileId) => {
        state.editingBlock[fileId] = null;
      });
    }),
  setSelectedArticleIds: (articleIds) =>
    set((state) => {
      const seen = new Set<string>();
      const next: string[] = [];
      for (const id of articleIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        next.push(id);
      }
      state.selectedArticleIds = next;
    }),
  toggleArticleSelection: (articleId, additive) =>
    set((state) => {
      const current = state.selectedArticleIds;
      const present = current.includes(articleId);
      if (!additive) {
        state.selectedArticleIds = present && current.length === 1 ? [] : [articleId];
        return;
      }
      state.selectedArticleIds = present
        ? current.filter((id) => id !== articleId)
        : [...current, articleId];
    }),
  clearArticleSelection: () =>
    set((state) => {
      if (state.selectedArticleIds.length > 0) state.selectedArticleIds = [];
    }),
  setOcrPanelHeight: (height) =>
    set((state) => {
      state.ocrPanelHeight = height;
    }),
});
