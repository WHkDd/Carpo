import type { StateCreator } from "zustand";
import type { QueueSlice } from "./queueSlice";
import type { UiSlice } from "./uiSlice";
import type { FileViewSlice } from "./fileViewSlice";
import type { SelectionRef, SelectionSlice } from "./selectionSlice";
import type { SettingsSlice } from "./settingsSlice";
import type { JobSlice } from "./jobSlice";
import { assembleDocument } from "@/lib/format-doc";

export interface Block {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  articleId: string | null;
  articleOrder: number | null;
}

export interface ArticleBlockRef {
  page: number;
  blockId: string;
  order: number;
}

export interface Article {
  id: string;
  num: number;
  title: string;
  blockRefs: ArticleBlockRef[];
}

export type ArticleInput = Omit<Article, "blockRefs"> &
  Partial<Pick<Article, "blockRefs">>;

export interface PageState {
  blocks: Block[];
}

export interface DocumentState {
  articles: Article[];
  newspaperName: string;
  newspaperDate: string;
}

/** Page range used by the M6 whole-file OCR trigger. `null` means "use the
 *  full page range of the current file" — equivalent to "全部". Stored per
 *  file so switching files (and switching back) preserves a custom range. */
export interface WholeFileRange {
  from: number;
  to: number;
}

export const EMPTY_PAGE_STATE: PageState = Object.freeze({
  blocks: Object.freeze([]) as unknown as Block[],
}) as PageState;

export const EMPTY_DOCUMENT_STATE: DocumentState = Object.freeze({
  articles: Object.freeze([]) as unknown as Article[],
  newspaperName: "",
  newspaperDate: "",
}) as DocumentState;

function makePageState(): PageState {
  return { blocks: [] };
}

function makeDocumentState(): DocumentState {
  return { articles: [], newspaperName: "", newspaperDate: "" };
}

export interface PageStateSlice {
  pageStates: Record<string, PageState>;
  documentStates: Record<string, DocumentState>;
  /** fileId → user-chosen subrange for the whole-file OCR trigger. `null`
   *  means full range (default). Cleared in `queueSlice.removeFile`. */
  wholeFileRange: Record<string, WholeFileRange | null>;
  addBlock: (fileId: string, page: number, block: Block) => void;
  updateBlock: (
    fileId: string,
    page: number,
    blockId: string,
    patch: Partial<Omit<Block, "id">>
  ) => void;
  removeBlock: (fileId: string, page: number, blockId: string) => void;
  removeBlocks: (fileId: string, page: number, blockIds: string[]) => void;
  addArticle: (
    fileId: string,
    page: number,
    article: ArticleInput,
    blockIds: string[]
  ) => void;
  markSelectionAsArticle: (
    fileId: string,
    page: number,
    articleId?: string
  ) => Article | null;
  removeArticle: (fileId: string, articleId: string) => void;
  updateArticle: (
    fileId: string,
    articleId: string,
    patch: Partial<Omit<Article, "id" | "blockRefs">>
  ) => void;
  clearArticles: (fileId: string) => void;
  unassignBlocksFromArticles: (
    fileId: string,
    page: number,
    blockIds: string[]
  ) => void;
  updatePageState: (
    fileId: string,
    page: number,
    patch: Partial<PageState>
  ) => void;
  updateDocumentMetadata: (
    fileId: string,
    patch: Partial<Pick<DocumentState, "newspaperName" | "newspaperDate">>
  ) => void;
  /** Set a custom page range for whole-file OCR. Pass `null` to reset to
   *  "full range". The caller is responsible for clamping/validating against
   *  the current file's `pdfTotal` — this is a raw setter. */
  setWholeFileRange: (fileId: string, range: WholeFileRange | null) => void;
  getPageState: (fileId: string, page: number) => PageState;
  getDocumentState: (fileId: string) => DocumentState;
}

export function pageKey(fileId: string, page: number): string {
  return `${fileId}::${page}`;
}

function newArticleId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function cloneArticle(article: Article): Article {
  return {
    ...article,
    blockRefs: article.blockRefs.map((ref) => ({ ...ref })),
  };
}

function normalizeArticleRefs(article: Article): void {
  article.blockRefs.sort((a, b) => a.order - b.order);
  article.blockRefs.forEach((ref, index) => {
    ref.order = index + 1;
  });
}

function renumberArticles(doc: DocumentState): void {
  doc.articles.forEach((article, index) => {
    const nextNum = index + 1;
    const hadDefaultTitle = /^报道\d+$/.test(article.title);
    article.num = nextNum;
    if (hadDefaultTitle) {
      article.title = `报道${nextNum}`;
    }
    normalizeArticleRefs(article);
  });
}

function removeEmptyArticles(doc: DocumentState): void {
  doc.articles = doc.articles.filter((article) => article.blockRefs.length > 0);
  renumberArticles(doc);
}

type PageSelectionState = PageStateSlice & SelectionSlice;
type PageJobState = PageStateSlice & JobSlice;

function refMatches(ref: ArticleBlockRef | SelectionRef, target: ArticleBlockRef): boolean {
  return ref.page === target.page && ref.blockId === target.blockId;
}

function pruneSelectionAndEditing(
  state: PageSelectionState,
  fileId: string,
  refs: readonly ArticleBlockRef[]
): void {
  if (refs.length === 0) return;
  const selection = state.selectionOrders[fileId];
  if (selection) {
    state.selectionOrders[fileId] = selection.filter(
      (selected) => !refs.some((ref) => refMatches(selected, ref))
    );
  }
  const editing = state.editingBlock[fileId];
  if (editing && refs.some((ref) => refMatches(editing, ref))) {
    state.editingBlock[fileId] = null;
  }
}

function refsForBlockIds(
  page: number,
  blockIds: Iterable<string>
): ArticleBlockRef[] {
  return Array.from(blockIds, (blockId) => ({ page, blockId, order: 0 }));
}

function syncArticleBlocks(
  state: PageStateSlice,
  fileId: string,
  doc: DocumentState
): void {
  const pagePrefix = `${fileId}::`;
  const blocksByPage = new Map<number, Map<string, Block>>();

  Object.entries(state.pageStates).forEach(([key, pageState]) => {
    if (!key.startsWith(pagePrefix)) return;
    const page = Number(key.slice(pagePrefix.length));
    if (!Number.isFinite(page)) return;
    const blockById = new Map<string, Block>();
    pageState.blocks.forEach((block) => {
      block.articleId = null;
      block.articleOrder = null;
      blockById.set(block.id, block);
    });
    blocksByPage.set(page, blockById);
  });

  doc.articles.forEach((article) => {
    normalizeArticleRefs(article);
    article.blockRefs.forEach((ref) => {
      const block = blocksByPage.get(ref.page)?.get(ref.blockId);
      if (!block) return;
      block.articleId = article.id;
      block.articleOrder = ref.order;
    });
  });
}

function unassignBlockRefs(
  state: PageStateSlice,
  fileId: string,
  page: number,
  blockIds: Set<string>
): void {
  const doc = state.documentStates[fileId];
  if (doc) {
    doc.articles.forEach((article) => {
      article.blockRefs = article.blockRefs.filter(
        (ref) => !(ref.page === page && blockIds.has(ref.blockId))
      );
    });
    removeEmptyArticles(doc);
    syncArticleBlocks(state, fileId, doc);
  }
}

function rebuildDocumentResult(
  state: PageJobState,
  fileId: string,
  doc: DocumentState
): void {
  const texts = state.articleOcrTexts[fileId] ?? {};
  const ordered = doc.articles
    .map((article) => ({
      title: article.title,
      text: texts[article.id] ?? "",
    }))
    .filter((article) => article.text.length > 0);

  if (ordered.length === 0) {
    delete state.documentResults[fileId];
    return;
  }

  state.documentResults[fileId] = assembleDocument({
    newspaperName: doc.newspaperName,
    newspaperDate: doc.newspaperDate,
    articles: ordered,
  });
}

export const createPageStateSlice: StateCreator<
  QueueSlice &
    UiSlice &
    FileViewSlice &
    PageStateSlice &
    SelectionSlice &
    SettingsSlice &
    JobSlice,
  [["zustand/immer", never]],
  [],
  PageStateSlice
> = (set, get) => ({
  pageStates: {},
  documentStates: {},
  wholeFileRange: {},

  addBlock: (fileId, page, block) =>
    set((state) => {
      const key = pageKey(fileId, page);
      const ps = state.pageStates[key] ?? makePageState();
      ps.blocks.push(block as Block);
      state.pageStates[key] = ps;
    }),

  updateBlock: (fileId, page, blockId, patch) =>
    set((state) => {
      const key = pageKey(fileId, page);
      const ps = state.pageStates[key];
      if (!ps) return;
      const idx = ps.blocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;
      ps.blocks[idx] = { ...ps.blocks[idx]!, ...patch };
    }),

  removeBlock: (fileId, page, blockId) =>
    set((state) => {
      const key = pageKey(fileId, page);
      const ps = state.pageStates[key];
      if (!ps) return;
      ps.blocks = ps.blocks.filter((b) => b.id !== blockId);
      pruneSelectionAndEditing(state, fileId, refsForBlockIds(page, [blockId]));
      unassignBlockRefs(state, fileId, page, new Set([blockId]));
    }),

  removeBlocks: (fileId, page, blockIds) =>
    set((state) => {
      const key = pageKey(fileId, page);
      const ps = state.pageStates[key];
      if (!ps) return;
      const idSet = new Set(blockIds);
      ps.blocks = ps.blocks.filter((b) => !idSet.has(b.id));
      pruneSelectionAndEditing(state, fileId, refsForBlockIds(page, idSet));
      unassignBlockRefs(state, fileId, page, idSet);
    }),

  addArticle: (fileId, page, article, blockIds) =>
    set((state) => {
      const key = pageKey(fileId, page);
      const ps = state.pageStates[key] ?? makePageState();
      const doc = state.documentStates[fileId] ?? makeDocumentState();
      const idSet = new Set(blockIds);
      unassignBlockRefs(state, fileId, page, idSet);

      const storedArticle: Article = {
        ...article,
        blockRefs:
          article.blockRefs ??
          blockIds.map((blockId, index) => ({
            page,
            blockId,
            order: index + 1,
          })),
      };

      doc.articles.push(storedArticle);
      renumberArticles(doc);
      state.pageStates[key] = ps;
      state.documentStates[fileId] = doc;
      syncArticleBlocks(state, fileId, doc);
    }),

  markSelectionAsArticle: (fileId, page, articleId) => {
    let marked: Article | null = null;

    set((state) => {
      void page;
      const selection = state.selectionOrders[fileId] ?? [];
      if (selection.length === 0) return;

      const selectedRefs = selection.filter((ref) => {
        const ps = state.pageStates[pageKey(fileId, ref.page)];
        return ps?.blocks.some((block) => block.id === ref.blockId);
      });
      if (selectedRefs.length === 0) return;

      const doc = state.documentStates[fileId] ?? makeDocumentState();
      doc.articles.forEach((article) => {
        article.blockRefs = article.blockRefs.filter(
          (ref) => !selectedRefs.some((selected) => refMatches(selected, ref))
        );
      });

      let article = articleId
        ? doc.articles.find((candidate) => candidate.id === articleId)
        : undefined;
      if (!article) {
        const nextNum =
          doc.articles.reduce((max, candidate) => Math.max(max, candidate.num), 0) + 1;
        article = {
          id: newArticleId(),
          num: nextNum,
          title: `报道${nextNum}`,
          blockRefs: [],
        };
        doc.articles.push(article);
      }

      const startOrder = article.blockRefs.reduce(
        (max, ref) => Math.max(max, ref.order),
        0
      );
      selectedRefs.forEach((ref, index) => {
        article!.blockRefs.push({
          page: ref.page,
          blockId: ref.blockId,
          order: startOrder + index + 1,
        });
      });

      doc.articles = doc.articles.filter(
        (candidate) => candidate.blockRefs.length > 0 || candidate.id === article!.id
      );
      renumberArticles(doc);
      state.selectionOrders[fileId] = [];
      state.documentStates[fileId] = doc;
      syncArticleBlocks(state, fileId, doc);
      marked = cloneArticle(article);
    });

    return marked;
  },

  removeArticle: (fileId, articleId) =>
    set((state) => {
      const doc = state.documentStates[fileId];
      if (!doc) return;
      const article = doc.articles.find((candidate) => candidate.id === articleId);
      if (!article) return;

      const refsToDelete = article.blockRefs.map((ref) => ({ ...ref }));
      refsToDelete.forEach((ref) => {
        const ps = state.pageStates[pageKey(fileId, ref.page)];
        if (ps) {
          ps.blocks = ps.blocks.filter((candidate) => candidate.id !== ref.blockId);
        }
      });
      pruneSelectionAndEditing(state, fileId, refsToDelete);
      doc.articles = doc.articles.filter((candidate) => candidate.id !== articleId);
      renumberArticles(doc);
      syncArticleBlocks(state, fileId, doc);
      if (state.articleOcrTexts[fileId]) {
        delete state.articleOcrTexts[fileId]![articleId];
        if (Object.keys(state.articleOcrTexts[fileId]!).length === 0) {
          delete state.articleOcrTexts[fileId];
        }
      }
      rebuildDocumentResult(state, fileId, doc);
    }),

  updateArticle: (fileId, articleId, patch) =>
    set((state) => {
      const doc = state.documentStates[fileId];
      if (!doc) return;
      const idx = doc.articles.findIndex((article) => article.id === articleId);
      if (idx === -1) return;
      doc.articles[idx] = { ...doc.articles[idx]!, ...patch };
    }),

  clearArticles: (fileId) =>
    set((state) => {
      const doc = state.documentStates[fileId] ?? makeDocumentState();
      const refsToDelete = doc.articles.flatMap((article) =>
        article.blockRefs.map((ref) => ({ ...ref }))
      );
      doc.articles.forEach((article) => {
        article.blockRefs.forEach((ref) => {
          const ps = state.pageStates[pageKey(fileId, ref.page)];
          if (ps) {
            ps.blocks = ps.blocks.filter(
              (candidate) => candidate.id !== ref.blockId
            );
          }
        });
      });
      pruneSelectionAndEditing(state, fileId, refsToDelete);
      doc.articles = [];
      state.documentStates[fileId] = doc;
      syncArticleBlocks(state, fileId, doc);
      delete state.articleOcrTexts[fileId];
      delete state.documentResults[fileId];
    }),

  unassignBlocksFromArticles: (fileId, page, blockIds) =>
    set((state) => {
      unassignBlockRefs(state, fileId, page, new Set(blockIds));
    }),

  updatePageState: (fileId, page, patch) =>
    set((state) => {
      const key = pageKey(fileId, page);
      const prev = state.pageStates[key] ?? makePageState();
      state.pageStates[key] = { ...prev, ...patch };
    }),

  updateDocumentMetadata: (fileId, patch) =>
    set((state) => {
      const doc = state.documentStates[fileId] ?? makeDocumentState();
      state.documentStates[fileId] = { ...doc, ...patch };
    }),

  setWholeFileRange: (fileId, range) =>
    set((state) => {
      if (range === null) {
        delete state.wholeFileRange[fileId];
      } else {
        state.wholeFileRange[fileId] = { from: range.from, to: range.to };
      }
    }),

  getPageState: (fileId, page) => {
    return get().pageStates[pageKey(fileId, page)] ?? EMPTY_PAGE_STATE;
  },

  getDocumentState: (fileId) => {
    return get().documentStates[fileId] ?? EMPTY_DOCUMENT_STATE;
  },
});
