import type { StateCreator } from "zustand";
import type { FileEntry, RenderedPagePayload } from "@/lib/ipc-types";
import type { FileViewSlice } from "./fileViewSlice";
import type { UiSlice } from "./uiSlice";
import { pageKeyFileId, type PageStateSlice } from "./pageStateSlice";
import type { SelectionSlice } from "./selectionSlice";
import type { SettingsSlice } from "./settingsSlice";
import type { JobSlice } from "./jobSlice";
import type { RestorableSnapshot } from "@/lib/session-snapshot";

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
  /** Points an image entry at a rotated copy of itself. Called as soon as the
   *  backend has committed the rotation — before the new preview loads — so
   *  no window exists where the new source sits beside old-frame state.
   *  Blocks, articles and every OCR / proofread result are dropped: their
   *  coordinates belong to the old orientation. Newspaper name, date and tags
   *  survive — they describe the document, not its pixels. The payload is
   *  cleared too; `usePdfPageSync` reloads it from the new path. */
  replaceRotatedImage: (id: string, path: string) => void;
  /** Appends a progress snapshot's files and their per-file work in one
   *  update. Files whose id is already queued are skipped whole — their live
   *  state wins. Selects the snapshot's current file when it was restored. */
  restoreSnapshot: (snapshot: RestorableSnapshot) => {
    added: number;
    skipped: number;
  };
}

type CombinedState = QueueSlice &
  UiSlice &
  FileViewSlice &
  PageStateSlice &
  SelectionSlice &
  SettingsSlice &
  JobSlice;

export const createQueueSlice: StateCreator<
  CombinedState,
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
      const normalized = normalizeFileEntry(entry);
      const existing = state.files.find((file) => file.id === entry.id);
      const exists = existing !== undefined;
      if (!exists) {
        state.files.push(normalized);
      }
      const activeFile = existing ?? normalized;
      state.currentFileId = activeFile.id;
      syncCurrentPageFields(state, activeFile);
    }),
  removeFile: (id) =>
    set((state) => {
      const index = state.files.findIndex((entry) => entry.id === id);
      if (index === -1) return;

      state.files.splice(index, 1);
      delete state.documentStates[id];
      delete state.fileViews[id];
      delete state.wholeFileRange[id];
      clearFileWork(state, id);
      // If we were viewing this file's drawer, drop the article scope so the
      // drawer (now empty) doesn't keep dangling articleId state.
      state.selectedArticleIds = [];
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
  replaceRotatedImage: (id, path) =>
    set((state) => {
      const file = state.files.find((entry) => entry.id === id);
      if (!file || file.kind !== "image") return;
      file.path = path;
      file.payload = undefined;
      clearFileWork(state, id);
      const doc = state.documentStates[id];
      if (doc) doc.articles = [];
      // The rotation may finish after the user moved to another file; only
      // drop the article scope if it belongs to this one.
      if (state.currentFileId === id) state.selectedArticleIds = [];
      // No stored view + dimensions arriving from zero = the canvas seeds a
      // fresh fit, square images included.
      delete state.fileViews[id];
    }),
  restoreSnapshot: (snapshot) => {
    const restored = new Set<string>();
    let skipped = 0;
    set((state) => {
      const queued = new Set(state.files.map((file) => file.id));
      for (const file of snapshot.files) {
        if (queued.has(file.id) || restored.has(file.id)) {
          skipped += 1;
          continue;
        }
        state.files.push(normalizeFileEntry(file));
        restored.add(file.id);
      }
      for (const key of SNAPSHOT_FILE_MAPS) {
        const source = (snapshot[key] ?? {}) as Record<string, unknown>;
        const target = state[key] as Record<string, unknown>;
        for (const id of restored) {
          if (id in source) target[id] = source[id];
        }
      }
      for (const [key, page] of Object.entries(snapshot.pageStates ?? {})) {
        if (restored.has(pageKeyFileId(key))) state.pageStates[key] = page;
      }
      const currentId =
        snapshot.currentFileId !== null && restored.has(snapshot.currentFileId)
          ? snapshot.currentFileId
          : restored.values().next().value;
      const current = state.files.find((file) => file.id === currentId);
      if (current) {
        state.currentFileId = current.id;
        state.selectedArticleIds = [];
        syncCurrentPageFields(state, current);
      }
    });
    return { added: restored.size, skipped };
  },
});

/** Per-file maps keyed directly by file id that a progress snapshot carries
 *  (`pageStates`, keyed `${fileId}::${page}`, is handled beside them). Zoom,
 *  selection and editing refs are left out: they are view state, not work. */
export const SNAPSHOT_FILE_MAPS = [
  "documentStates",
  "wholeFileRange",
  "documentResults",
  "articleOcrTexts",
  "articleOcrRegions",
  "pageOcrTexts",
  "recognizedPages",
  "proofreadReviews",
] as const;

/** Drops everything derived from a file's pixels: blocks, selection and
 *  editing refs, and every OCR / proofread result. Shared by removal and
 *  rotation so a new per-file map only has to be added in one place. */
function clearFileWork(state: CombinedState, id: string): void {
  delete state.selectionOrders[id];
  delete state.documentResults[id];
  delete state.articleOcrTexts[id];
  delete state.articleOcrRegions[id];
  delete state.pageOcrTexts[id];
  delete state.recognizedPages[id];
  delete state.proofreadReviews[id];
  delete state.editingBlock[id];
  delete state.editingLayoutBlock[id];
  delete state.focusedRegion[id];
  const pagePrefix = `${id}::`;
  Object.keys(state.pageStates).forEach((key) => {
    if (key.startsWith(pagePrefix)) {
      delete state.pageStates[key];
    }
  });
}

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
