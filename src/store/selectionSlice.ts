import type { StateCreator } from "zustand";
import type { QueueSlice } from "./queueSlice";
import type { UiSlice } from "./uiSlice";
import type { FileViewSlice } from "./fileViewSlice";
import type { PageStateSlice } from "./pageStateSlice";
import type { SettingsSlice } from "./settingsSlice";
import type { JobSlice } from "./jobSlice";

const EMPTY_SELECTION: readonly string[] = Object.freeze([]);
const EMPTY_SELECTION_REFS: readonly SelectionRef[] = Object.freeze([]);

export interface SelectionRef {
  page: number;
  blockId: string;
}

export interface EditingBlockRef {
  page: number;
  blockId: string;
}

/** Which layout block's textarea currently has focus, by index into
 *  `LayoutPage.blocks`. Deliberately the same file-keyed shape as
 *  `EditingBlockRef`: the `page` field makes a page turn invalidate the
 *  highlight for free, with no per-page keys to sweep on file removal. */
export interface EditingLayoutBlockRef {
  page: number;
  index: number;
}

/** A region of the page the canvas should outline and bring into view, in
 *  preview-bitmap pixels.
 *
 *  Separate from [`EditingLayoutBlockRef`] because that one points at a block
 *  *by index* into a layout page, and the case this exists for has no layout
 *  block to index: a grouped article is recognized as one piece, so a
 *  proofread suggestion inside it cannot be traced to a single block — only
 *  to the article's own outline. Carrying one rect per page (rather than a
 *  page + rect) means an article continued across a page break lights up on
 *  whichever of its pages the canvas is showing. */
export interface FocusedRegionRef {
  rects: FocusedRegionRect[];
}

export interface FocusedRegionRect {
  page: number;
  rect: { x: number; y: number; width: number; height: number };
}

export interface SelectionSlice {
  manualDrawMode: boolean;
  selectionOrders: Record<string, SelectionRef[]>;
  editingBlock: Record<string, EditingBlockRef | null>;
  editingLayoutBlock: Record<string, EditingLayoutBlockRef | null>;
  focusedRegion: Record<string, FocusedRegionRef | null>;
  toggleDrawMode: () => void;
  setDrawMode: (active: boolean) => void;
  pushSelection: (fileId: string, page: number, id: string) => void;
  popSelection: (fileId: string, page: number) => void;
  clearSelection: (fileId: string, page: number) => void;
  removeFromSelection: (fileId: string, page: number, id: string) => void;
  setEditingBlock: (fileId: string, ref: EditingBlockRef | null) => void;
  /** Called from the block list's focus / blur handlers. Focus rather than
   *  click, so tabbing through the blocks moves the canvas highlight too — a
   *  mouse user and a keyboard user get the same feature. */
  setEditingLayoutBlock: (
    fileId: string,
    ref: EditingLayoutBlockRef | null
  ) => void;
  setFocusedRegion: (fileId: string, ref: FocusedRegionRef | null) => void;
  getSelectionOrder: (fileId: string, page: number) => readonly string[];
  getFileSelectionOrder: (fileId: string) => readonly SelectionRef[];
  getEditingBlockId: (fileId: string, page: number) => string | null;
  /** `null` when nothing is focused, or when the focused block belongs to a
   *  page other than the one asked about. */
  getEditingLayoutBlockIndex: (fileId: string, page: number) => number | null;
  /** The focused region's rectangle on `page`, or `null` when nothing is
   *  focused or the region does not reach this page. Returns the *stored*
   *  object, never a copy: this is read from a zustand selector, whose
   *  snapshot has to be referentially stable or the subscriber re-renders
   *  forever (React #185). */
  getFocusedRegionRect: (
    fileId: string,
    page: number
  ) => FocusedRegionRect["rect"] | null;
}

export const createSelectionSlice: StateCreator<
  QueueSlice &
    UiSlice &
    FileViewSlice &
    PageStateSlice &
    SelectionSlice &
    SettingsSlice &
    JobSlice,
  [["zustand/immer", never]],
  [],
  SelectionSlice
> = (set, get) => ({
  manualDrawMode: false,
  selectionOrders: {},
  editingBlock: {},
  editingLayoutBlock: {},
  focusedRegion: {},

  toggleDrawMode: () =>
    set((state) => {
      if (state.recognitionMode === "whole_file") {
        state.manualDrawMode = false;
        return;
      }
      state.manualDrawMode = !state.manualDrawMode;
    }),

  setDrawMode: (active) =>
    set((state) => {
      state.manualDrawMode = state.recognitionMode === "whole_file"
        ? false
        : active;
    }),

  pushSelection: (fileId, page, id) =>
    set((state) => {
      const list = state.selectionOrders[fileId] ?? [];
      const next = list.filter(
        (ref) => !(ref.page === page && ref.blockId === id)
      );
      next.push({ page, blockId: id });
      state.selectionOrders[fileId] = next;
    }),

  popSelection: (fileId, page) =>
    set((state) => {
      void page;
      const list = state.selectionOrders[fileId];
      if (!list || list.length === 0) return;
      list.pop();
    }),

  clearSelection: (fileId, page) =>
    set((state) => {
      void page;
      if (state.selectionOrders[fileId]) {
        state.selectionOrders[fileId] = [];
      }
    }),

  removeFromSelection: (fileId, page, id) =>
    set((state) => {
      const list = state.selectionOrders[fileId];
      if (!list) return;
      state.selectionOrders[fileId] = list.filter(
        (ref) => !(ref.page === page && ref.blockId === id)
      );
    }),

  setEditingBlock: (fileId, ref) =>
    set((state) => {
      state.editingBlock[fileId] = ref;
    }),

  setEditingLayoutBlock: (fileId, ref) =>
    set((state) => {
      state.editingLayoutBlock[fileId] = ref;
    }),

  setFocusedRegion: (fileId, ref) =>
    set((state) => {
      state.focusedRegion[fileId] = ref;
    }),

  getSelectionOrder: (fileId, page) => {
    const refs = get().selectionOrders[fileId];
    if (!refs) return EMPTY_SELECTION;
    return refs
      .filter((ref) => ref.page === page)
      .map((ref) => ref.blockId);
  },

  getFileSelectionOrder: (fileId) => {
    return get().selectionOrders[fileId] ?? EMPTY_SELECTION_REFS;
  },

  getEditingBlockId: (fileId, page) => {
    const ref = get().editingBlock[fileId];
    if (!ref) return null;
    return ref.page === page ? ref.blockId : null;
  },

  getEditingLayoutBlockIndex: (fileId, page) => {
    const ref = get().editingLayoutBlock[fileId];
    if (!ref) return null;
    return ref.page === page ? ref.index : null;
  },

  getFocusedRegionRect: (fileId, page) => {
    const ref = get().focusedRegion[fileId];
    if (!ref) return null;
    return ref.rects.find((entry) => entry.page === page)?.rect ?? null;
  },
});
