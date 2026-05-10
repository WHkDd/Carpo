import type { StateCreator } from "zustand";
import type { QueueSlice } from "./queueSlice";
import type { UiSlice } from "./uiSlice";
import type { FileViewSlice } from "./fileViewSlice";
import type { PageStateSlice } from "./pageStateSlice";
import type { SettingsSlice } from "./settingsSlice";
import { pageKey } from "./pageStateSlice";

const EMPTY_SELECTION: readonly string[] = Object.freeze([]);

export interface SelectionSlice {
  manualDrawMode: boolean;
  selectionOrders: Record<string, string[]>;
  toggleDrawMode: () => void;
  setDrawMode: (active: boolean) => void;
  pushSelection: (fileId: string, page: number, id: string) => void;
  popSelection: (fileId: string, page: number) => void;
  clearSelection: (fileId: string, page: number) => void;
  removeFromSelection: (fileId: string, page: number, id: string) => void;
  getSelectionOrder: (fileId: string, page: number) => readonly string[];
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
      const key = pageKey(fileId, page);
      const list = state.selectionOrders[key] ?? [];
      const next = list.filter((s) => s !== id);
      next.push(id);
      state.selectionOrders[key] = next;
    }),

  popSelection: (fileId, page) =>
    set((state) => {
      const key = pageKey(fileId, page);
      const list = state.selectionOrders[key];
      if (!list || list.length === 0) return;
      list.pop();
    }),

  clearSelection: (fileId, page) =>
    set((state) => {
      const key = pageKey(fileId, page);
      if (state.selectionOrders[key]) {
        state.selectionOrders[key] = [];
      }
    }),

  removeFromSelection: (fileId, page, id) =>
    set((state) => {
      const key = pageKey(fileId, page);
      const list = state.selectionOrders[key];
      if (!list) return;
      state.selectionOrders[key] = list.filter((s) => s !== id);
    }),

  getSelectionOrder: (fileId, page) => {
    return get().selectionOrders[pageKey(fileId, page)] ?? EMPTY_SELECTION;
  },
});
