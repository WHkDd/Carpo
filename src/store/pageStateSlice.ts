import type { StateCreator } from "zustand";
import type { QueueSlice } from "./queueSlice";
import type { UiSlice } from "./uiSlice";

export interface PageState {
  zoomPercent: number;
  panX: number;
  panY: number;
}

export interface PageStateSlice {
  pageStates: Record<string, PageState>;
  setPageState: (
    fileId: string,
    page: number,
    patch: Partial<PageState>
  ) => void;
  setPageZoomPercent: (
    fileId: string,
    page: number,
    zoomPercent: number
  ) => void;
  setPagePan: (fileId: string, page: number, panX: number, panY: number) => void;
  getPageState: (fileId: string, page: number) => PageState;
}

export const DEFAULT_PAGE_STATE: PageState = {
  zoomPercent: 100,
  panX: 0,
  panY: 0,
};

export function pageStateKey(fileId: string, page: number): string {
  return `${fileId}::${Math.max(1, Math.floor(page))}`;
}

export const createPageStateSlice: StateCreator<
  QueueSlice & UiSlice & PageStateSlice,
  [["zustand/immer", never]],
  [],
  PageStateSlice
> = (set, get) => ({
  pageStates: {},
  setPageState: (fileId, page, patch) =>
    set((state) => {
      const key = pageStateKey(fileId, page);
      state.pageStates[key] = {
        ...DEFAULT_PAGE_STATE,
        ...state.pageStates[key],
        ...patch,
      };
    }),
  setPageZoomPercent: (fileId, page, zoomPercent) =>
    set((state) => {
      const key = pageStateKey(fileId, page);
      state.pageStates[key] = {
        ...DEFAULT_PAGE_STATE,
        ...state.pageStates[key],
        zoomPercent,
      };
    }),
  setPagePan: (fileId, page, panX, panY) =>
    set((state) => {
      const key = pageStateKey(fileId, page);
      state.pageStates[key] = {
        ...DEFAULT_PAGE_STATE,
        ...state.pageStates[key],
        panX,
        panY,
      };
    }),
  getPageState: (fileId, page) => {
    const state = get().pageStates[pageStateKey(fileId, page)];
    return state ? { ...DEFAULT_PAGE_STATE, ...state } : DEFAULT_PAGE_STATE;
  },
});
