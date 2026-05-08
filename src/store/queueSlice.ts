import type { StateCreator } from "zustand";
import type { FileEntry, RenderedPagePayload } from "@/lib/ipc-types";
import type { FileViewSlice } from "./fileViewSlice";
import type { UiSlice } from "./uiSlice";

export interface QueueSlice {
  files: FileEntry[];
  currentFileId: string | null;
  pdfTotal: number;
  currentPage: number;
  addFile: (entry: FileEntry) => void;
  removeFile: (id: string) => void;
  setCurrent: (id: string | null) => void;
  setPdfTotal: (id: string, pdfTotal: number) => void;
  setCurrentPage: (id: string, page: number) => void;
  prevPage: () => void;
  nextPage: () => void;
  setFilePayload: (
    id: string,
    payload: RenderedPagePayload,
    payloadPage?: number
  ) => void;
}

export const createQueueSlice: StateCreator<
  QueueSlice & UiSlice & FileViewSlice,
  [["zustand/immer", never]],
  [],
  QueueSlice
> = (set) => ({
  files: [],
  currentFileId: null,
  pdfTotal: 1,
  currentPage: 1,
  addFile: (entry) =>
    set((state) => {
      const exists = state.files.some((file) => file.id === entry.id);
      if (!exists) {
        state.files.push(normalizeFileEntry(entry));
      }
      if (state.currentFileId === null) {
        state.currentFileId = entry.id;
        syncCurrentPageFields(state, normalizeFileEntry(entry));
      }
    }),
  removeFile: (id) =>
    set((state) => {
      const index = state.files.findIndex((entry) => entry.id === id);
      if (index === -1) return;

      state.files.splice(index, 1);
      if (state.currentFileId !== id) return;

      const replacement = state.files[index] ?? state.files[index - 1] ?? null;
      state.currentFileId = replacement?.id ?? null;
      syncCurrentPageFields(state, replacement);
    }),
  setCurrent: (id) =>
    set((state) => {
      state.currentFileId = id;
      const file = state.files.find((entry) => entry.id === id) ?? null;
      syncCurrentPageFields(state, file);
    }),
  setPdfTotal: (id, pdfTotal) =>
    set((state) => {
      const file = state.files.find((entry) => entry.id === id);
      if (!file) return;

      file.pdfTotal = normalizeTotal(pdfTotal);
      file.currentPage = clampPage(file.currentPage ?? 1, file.pdfTotal);
      if (state.currentFileId === id) {
        syncCurrentPageFields(state, file);
      }
    }),
  setCurrentPage: (id, page) =>
    set((state) => {
      const file = state.files.find((entry) => entry.id === id);
      if (!file) return;

      file.currentPage = clampPage(page, file.pdfTotal ?? 1);
      if (state.currentFileId === id) {
        syncCurrentPageFields(state, file);
      }
    }),
  prevPage: () =>
    set((state) => {
      const file = state.files.find((entry) => entry.id === state.currentFileId);
      if (!file) return;

      file.currentPage = clampPage((file.currentPage ?? 1) - 1, file.pdfTotal ?? 1);
      syncCurrentPageFields(state, file);
    }),
  nextPage: () =>
    set((state) => {
      const file = state.files.find((entry) => entry.id === state.currentFileId);
      if (!file) return;

      file.currentPage = clampPage((file.currentPage ?? 1) + 1, file.pdfTotal ?? 1);
      syncCurrentPageFields(state, file);
    }),
  setFilePayload: (id, payload, payloadPage) =>
    set((state) => {
      const file = state.files.find((entry) => entry.id === id);
      if (file) {
        file.payload = payload;
        if (payloadPage !== undefined) {
          file.payloadPage = payloadPage;
        }
      }
    }),
});

function normalizeFileEntry(entry: FileEntry): FileEntry {
  const pdfTotal = normalizeTotal(entry.pdfTotal ?? 1);
  return {
    ...entry,
    pdfTotal,
    currentPage: clampPage(entry.currentPage ?? 1, pdfTotal),
  };
}

function normalizeTotal(pdfTotal: number): number {
  return Math.max(1, Math.floor(pdfTotal));
}

function clampPage(page: number, pdfTotal: number): number {
  return Math.min(normalizeTotal(pdfTotal), Math.max(1, Math.floor(page)));
}

function syncCurrentPageFields(
  state: QueueSlice,
  file: FileEntry | null
): void {
  state.currentPage = file?.currentPage ?? 1;
  state.pdfTotal = file?.pdfTotal ?? 1;
}
