import type { StateCreator } from "zustand";
import type { QueueSlice } from "./queueSlice";
import type { UiSlice } from "./uiSlice";
import type { PageStateSlice } from "./pageStateSlice";
import type { SelectionSlice } from "./selectionSlice";
import type { SettingsSlice } from "./settingsSlice";
import type { JobSlice } from "./jobSlice";

export interface FileView {
  zoomPercent: number;
  panX: number;
  panY: number;
  // True after fit() — page changes auto-recompute fit + recenter.
  // Wheel / +/- / manual percent input flips this back to false.
  isFit: boolean;
}

export const DEFAULT_FILE_VIEW: FileView = {
  zoomPercent: 100,
  panX: 0,
  panY: 0,
  isFit: true,
};

export interface FileViewSlice {
  fileViews: Record<string, FileView>;
  setFileView: (fileId: string, view: FileView) => void;
  setFileZoomAndPan: (
    fileId: string,
    zoomPercent: number,
    panX: number,
    panY: number
  ) => void;
  setFilePan: (fileId: string, panX: number, panY: number) => void;
  getFileView: (fileId: string) => FileView;
}

export const createFileViewSlice: StateCreator<
  QueueSlice &
    UiSlice &
    FileViewSlice &
    PageStateSlice &
    SelectionSlice &
    SettingsSlice &
    JobSlice,
  [["zustand/immer", never]],
  [],
  FileViewSlice
> = (set, get) => ({
  fileViews: {},
  setFileView: (fileId, view) =>
    set((state) => {
      state.fileViews[fileId] = { ...view };
    }),
  setFileZoomAndPan: (fileId, zoomPercent, panX, panY) =>
    set((state) => {
      const previous = state.fileViews[fileId];
      state.fileViews[fileId] = {
        ...DEFAULT_FILE_VIEW,
        ...previous,
        zoomPercent,
        panX,
        panY,
        isFit: false,
      };
    }),
  setFilePan: (fileId, panX, panY) =>
    set((state) => {
      const previous = state.fileViews[fileId];
      state.fileViews[fileId] = {
        ...DEFAULT_FILE_VIEW,
        ...previous,
        panX,
        panY,
      };
    }),
  getFileView: (fileId) => get().fileViews[fileId] ?? DEFAULT_FILE_VIEW,
});
