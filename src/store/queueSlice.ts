import type { StateCreator } from "zustand";
import type { FileEntry, RenderedPagePayload } from "@/lib/ipc-types";
import type { FileViewSlice } from "./fileViewSlice";
import type { UiSlice } from "./uiSlice";
import { pageKeyFileId, type PageStateSlice } from "./pageStateSlice";
import type { SelectionSlice } from "./selectionSlice";
import type { SettingsSlice } from "./settingsSlice";
import type { JobSlice } from "./jobSlice";
import type { RestorableSnapshot } from "@/lib/session-snapshot";
import type { QueueView } from "@/lib/queue-view";

export interface QueueSlice extends QueueView {
  files: FileEntry[];
  manualQueueFileIds: string[];
  selectedQueueFileIds: string[];
  queueSelectionAnchor: string | null;
  setQueueView: (patch: Partial<QueueView>) => void;
  selectQueueFile: (
    id: string,
    visibleIds: string[],
    additive?: boolean,
    range?: boolean,
  ) => void;
  setQueueSelection: (ids: string[]) => void;
  setQueueStarred: (ids: string[], starred: boolean) => void;
  moveQueueFiles: (ids: string[], targetId: string, after?: boolean) => void;
  removeFiles: (ids: string[], displayOrder?: string[]) => void;
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
    payloadPage?: number,
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
  manualQueueFileIds: [],
  selectedQueueFileIds: [],
  queueSelectionAnchor: null,
  queueSortField: "manual",
  queueSortAscending: true,
  queueGroupMode: "none",
  queueSearchText: "",
  setQueueView: (patch) =>
    set((state) => {
      Object.assign(state, patch);
    }),
  setQueueSelection: (ids) =>
    set((state) => {
      const queued = new Set(state.files.map((file) => file.id));
      state.selectedQueueFileIds = [...new Set(ids)].filter((id) =>
        queued.has(id),
      );
    }),
  selectQueueFile: (id, visibleIds, additive = false, range = false) =>
    set((state) => {
      const visible = [...new Set(visibleIds)];
      const at = visible.indexOf(id);
      if (at < 0) return;
      const selected = new Set(
        state.selectedQueueFileIds.filter((key) => visible.includes(key)),
      );
      if (range) {
        const anchor = visible.indexOf(
          state.queueSelectionAnchor ?? state.currentFileId ?? id,
        );
        const start = anchor < 0 ? at : anchor;
        const span = visible.slice(
          Math.min(start, at),
          Math.max(start, at) + 1,
        );
        state.selectedQueueFileIds = additive
          ? [...new Set([...selected, ...span])]
          : span;
      } else {
        if (additive) {
          if (selected.has(id)) selected.delete(id);
          else selected.add(id);
          state.selectedQueueFileIds = [...selected];
        } else state.selectedQueueFileIds = [id];
        state.queueSelectionAnchor = id;
      }
      const current = state.selectedQueueFileIds.includes(id)
        ? id
        : (state.selectedQueueFileIds[0] ?? null);
      if (state.currentFileId !== current) state.selectedArticleIds = [];
      state.currentFileId = current;
      syncCurrentPageFields(
        state,
        state.files.find((file) => file.id === current) ?? null,
      );
    }),
  setQueueStarred: (ids, starred) =>
    set((state) => {
      const chosen = new Set(ids);
      for (const file of state.files)
        if (chosen.has(file.id)) file.isStarred = starred;
    }),
  moveQueueFiles: (ids, targetId, after = false) =>
    set((state) => {
      if (
        state.queueSortField !== "manual" ||
        state.queueGroupMode !== "none" ||
        state.queueSearchText.trim()
      )
        return;
      const displayed = manualQueueFiles(state.files, state.manualQueueFileIds);
      const order = reorderedQueue(displayed, ids, targetId, after);
      if (order) state.manualQueueFileIds = order;
    }),
  removeFiles: (ids, displayOrder) =>
    set((state) => {
      removeQueuedFiles(state, new Set(ids), displayOrder);
    }),
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
        state.manualQueueFileIds.push(normalized.id);
      }
      const activeFile = existing ?? normalized;
      if (state.currentFileId !== activeFile.id) state.selectedArticleIds = [];
      state.currentFileId = activeFile.id;
      state.selectedQueueFileIds = [activeFile.id];
      state.queueSelectionAnchor = activeFile.id;
      syncCurrentPageFields(state, activeFile);
    }),
  removeFile: (id) =>
    set((state) => {
      removeQueuedFiles(state, new Set([id]));
    }),
  setCurrent: (id) =>
    set((state) => {
      if (state.currentFileId !== id) state.selectedArticleIds = [];
      state.currentFileId = id;
      if (!id) state.selectedQueueFileIds = [];
      else if (!state.selectedQueueFileIds.includes(id)) {
        state.selectedQueueFileIds = [id];
        state.queueSelectionAnchor = id;
      }
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
      const file = state.files.find(
        (entry) => entry.id === state.currentFileId,
      );
      if (!file) return;

      file.currentPage = clampPage(
        (file.currentPage ?? 1) - 1,
        file.pdfTotal ?? 1,
      );
      syncCurrentPageFields(state, file);
    }),
  nextPage: () =>
    set((state) => {
      const file = state.files.find(
        (entry) => entry.id === state.currentFileId,
      );
      if (!file) return;

      file.currentPage = clampPage(
        (file.currentPage ?? 1) + 1,
        file.pdfTotal ?? 1,
      );
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
      const snapshotOrder = [
        ...new Set([
          ...(snapshot.manualQueueFileIds ?? []),
          ...snapshot.files.map((file) => file.id),
        ]),
      ];
      state.manualQueueFileIds.push(
        ...snapshotOrder.filter((id) => restored.has(id)),
      );
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
        state.selectedQueueFileIds = [current.id];
        state.queueSelectionAnchor = current.id;
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

function removeQueuedFiles(
  state: CombinedState,
  ids: Set<string>,
  displayOrder?: string[],
): void {
  const displayed = manualQueueFiles(
    state.files,
    displayOrder ?? state.manualQueueFileIds,
  );
  const currentIndex = displayed.findIndex(
    (file) => file.id === state.currentFileId,
  );
  const removedCurrent =
    state.currentFileId !== null && ids.has(state.currentFileId);
  for (const file of state.files) {
    if (!ids.has(file.id)) continue;
    delete state.documentStates[file.id];
    delete state.fileViews[file.id];
    delete state.wholeFileRange[file.id];
    clearFileWork(state, file.id);
  }
  state.files = state.files.filter((file) => !ids.has(file.id));
  state.manualQueueFileIds = state.manualQueueFileIds.filter(
    (id) => !ids.has(id),
  );
  state.selectedQueueFileIds = state.selectedQueueFileIds.filter(
    (id) => !ids.has(id),
  );
  if (state.queueSelectionAnchor && ids.has(state.queueSelectionAnchor))
    state.queueSelectionAnchor = null;
  if (!removedCurrent) return;
  const remaining = displayed.filter((file) => !ids.has(file.id));
  const replacement =
    remaining.find((file) => state.selectedQueueFileIds.includes(file.id)) ??
    displayed.slice(currentIndex + 1).find((file) => !ids.has(file.id)) ??
    remaining.at(-1) ??
    null;
  state.currentFileId = replacement?.id ?? null;
  state.selectedArticleIds = [];
  if (replacement && !state.selectedQueueFileIds.length)
    state.selectedQueueFileIds = [replacement.id];
  syncCurrentPageFields(state, replacement);
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
  file: FileEntry | null,
): void {
  state.currentPage = file?.currentPage ?? 1;
  state.pdfTotal = file?.pdfTotal ?? 1;
}

export function manualQueueFiles(
  files: FileEntry[],
  order: string[],
): FileEntry[] {
  const positions = new Map(
    [...new Set([...order, ...files.map((file) => file.id)])].map(
      (id, index) => [id, index],
    ),
  );
  return [...files].sort(
    (a, b) =>
      Number(!!b.isStarred) - Number(!!a.isStarred) ||
      positions.get(a.id)! - positions.get(b.id)!,
  );
}

/** Returns null for a cross-star drop; selected files retain their relative order. */
export function reorderedQueue(
  displayed: FileEntry[],
  ids: string[],
  targetId: string,
  after: boolean,
): string[] | null {
  const chosen = new Set(ids);
  const moving = displayed.filter((file) => chosen.has(file.id));
  const target = displayed.find((file) => file.id === targetId);
  if (
    !moving.length ||
    moving.length !== chosen.size ||
    !target ||
    chosen.has(targetId) ||
    moving.some((file) => !!file.isStarred !== !!target.isStarred)
  )
    return null;
  const rest = displayed.filter((file) => !chosen.has(file.id));
  const at = rest.findIndex((file) => file.id === targetId) + Number(after);
  rest.splice(at, 0, ...moving);
  return rest.map((file) => file.id);
}
