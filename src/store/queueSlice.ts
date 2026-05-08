import type { StateCreator } from "zustand";
import type { FileEntry, RenderedPagePayload } from "@/lib/ipc-types";
import type { UiSlice } from "./uiSlice";

export interface QueueSlice {
  files: FileEntry[];
  currentFileId: string | null;
  addFile: (entry: FileEntry) => void;
  setCurrent: (id: string | null) => void;
  setFilePayload: (id: string, payload: RenderedPagePayload) => void;
}

export const createQueueSlice: StateCreator<
  QueueSlice & UiSlice,
  [["zustand/immer", never]],
  [],
  QueueSlice
> = (set) => ({
  files: [],
  currentFileId: null,
  addFile: (entry) =>
    set((state) => {
      const exists = state.files.some((file) => file.id === entry.id);
      if (!exists) {
        state.files.push(entry);
      }
      if (state.currentFileId === null) {
        state.currentFileId = entry.id;
      }
    }),
  setCurrent: (id) =>
    set((state) => {
      state.currentFileId = id;
    }),
  setFilePayload: (id, payload) =>
    set((state) => {
      const file = state.files.find((entry) => entry.id === id);
      if (file) {
        file.payload = payload;
      }
    }),
});
