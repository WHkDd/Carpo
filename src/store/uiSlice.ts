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

/** Grid column widths of the left queue panel, in its two states. */
export const QUEUE_WIDTH = 244;
export const QUEUE_COLLAPSED_WIDTH = 76;

/** Drag-resizable right rail. 384 is both the design default and the floor:
 *  it is the width at which the OCR panel header still holds its widest
 *  layout on one line — a whole-file pager with a four-digit page count and
 *  the review dot on the left, the full nine-control icon cluster (two view
 *  switches, block + review views, copy, export menu, proofread, and the two
 *  dividers) on the right. Anything narrower wraps the icons onto a second
 *  row. Dragging only ever widens the rail (up to double) to give the OCR
 *  text panel more room. */
export const RAIL_MIN_WIDTH = 384;
export const RAIL_MAX_WIDTH = 768;

/** Floor for the canvas column. Only binds once the rail is dragged wide: at
 *  the default rail width the canvas is far above it even in the smallest
 *  window the OS will allow. */
export const CANVAS_MIN_WIDTH = 480;

/** Widest the rail may get inside a shell of `shellWidth`, leaving the queue
 *  panel and the canvas floor intact. Below RAIL_MIN_WIDTH there is nothing
 *  left to give, so the floor wins and the canvas is squeezed instead — that
 *  only happens in a window narrower than the configured minimum. */
export function railMaxWidth(shellWidth: number, queueWidth: number): number {
  const available = shellWidth - queueWidth - CANVAS_MIN_WIDTH;
  return Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, available));
}

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
  /** Pixel width of the right rail. In-memory only, like `ocrPanelHeight` —
   *  widening it is a per-document reading gesture, not a lasting preference. */
  railWidth: number;
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
  /** Set the rail width. Like `setOcrPanelHeight` this is a raw setter — the
   *  caller clamps against the live shell width, which only it knows. */
  setRailWidth: (width: number) => void;
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
  railWidth: RAIL_MIN_WIDTH,
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
  setRailWidth: (width) =>
    set((state) => {
      state.railWidth = width;
    }),
});
