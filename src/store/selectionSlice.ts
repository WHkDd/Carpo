import type { StateCreator } from "zustand";
import type { QueueSlice } from "./queueSlice";
import type { UiSlice } from "./uiSlice";
import type { FileViewSlice } from "./fileViewSlice";
import type { PageStateSlice } from "./pageStateSlice";
import type { SettingsSlice } from "./settingsSlice";

const EMPTY_SELECTION: readonly string[] = Object.freeze([]);
const EMPTY_SELECTION_REFS: readonly SelectionRef[] = Object.freeze([]);

export interface SelectionRef {
  page: number;
  blockId: string;
}

export interface SelectionSlice {
  manualDrawMode: boolean;
  selectionOrders: Record<string, SelectionRef[]>;
  toggleDrawMode: () => void;
  setDrawMode: (active: boolean) => void;
  pushSelection: (fileId: string, page: number, id: string) => void;
  popSelection: (fileId: string, page: number) => void;
  clearSelection: (fileId: string, page: number) => void;
  removeFromSelection: (fileId: string, page: number, id: string) => void;
  getSelectionOrder: (fileId: string, page: number) => readonly string[];
  getFileSelectionOrder: (fileId: string) => readonly SelectionRef[];
}

export const createSelectionSlice: StateCreator<
  QueueSlice &
    UiSlice &
    FileViewSlice &
    PageStateSlice &
    SelectionSlice &
    SettingsSlice,
  [["zustand/immer", never]],
  [],
  SelectionSlice
> = (set, get) => ({
  manualDrawMode: false,
  selectionOrders: {},

  toggleDrawMode: () =>
    set((state) => {
      state.manualDrawMode = !state.manualDrawMode;
    }),

  setDrawMode: (active) =>
    set((state) => {
      state.manualDrawMode = active;
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
});
