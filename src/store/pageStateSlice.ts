import type { StateCreator } from "zustand";
import type { QueueSlice } from "./queueSlice";
import type { UiSlice } from "./uiSlice";
import type { FileViewSlice } from "./fileViewSlice";
import type { SelectionSlice } from "./selectionSlice";
import type { SettingsSlice } from "./settingsSlice";

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

function unassignBlockRefs(
  state: PageStateSlice,
  fileId: string,
  page: number,
  blockIds: Set<string>
): void {
  const key = pageKey(fileId, page);
  const ps = state.pageStates[key];
  if (ps) {
    ps.blocks.forEach((block) => {
      if (blockIds.has(block.id)) {
        block.articleId = null;
        block.articleOrder = null;
      }
    });
  }

  const doc = state.documentStates[fileId];
  if (doc) {
    doc.articles.forEach((article) => {
      article.blockRefs = article.blockRefs.filter(
        (ref) => !(ref.page === page && blockIds.has(ref.blockId))
      );
    });
    removeEmptyArticles(doc);
  }
}

export const createPageStateSlice: StateCreator<
  QueueSlice &
    UiSlice &
    FileViewSlice &
    PageStateSlice &
    SelectionSlice &
    SettingsSlice,
  [["zustand/immer", never]],
  [],
  PageStateSlice
> = (set, get) => ({
  pageStates: {},
  documentStates: {},

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
      const selection = state.selectionOrders[key];
      if (selection) state.selectionOrders[key] = selection.filter((id) => id !== blockId);
      unassignBlockRefs(state, fileId, page, new Set([blockId]));
    }),

  removeBlocks: (fileId, page, blockIds) =>
    set((state) => {
      const key = pageKey(fileId, page);
      const ps = state.pageStates[key];
      if (!ps) return;
      const idSet = new Set(blockIds);
      ps.blocks = ps.blocks.filter((b) => !idSet.has(b.id));
      const selection = state.selectionOrders[key];
      if (selection) state.selectionOrders[key] = selection.filter((id) => !idSet.has(id));
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
      blockIds.forEach((bid, i) => {
        const b = ps.blocks.find((block) => block.id === bid);
        if (b) {
          b.articleId = storedArticle.id;
          b.articleOrder = i + 1;
        }
      });
      renumberArticles(doc);
      state.pageStates[key] = ps;
      state.documentStates[fileId] = doc;
    }),

  markSelectionAsArticle: (fileId, page, articleId) => {
    let marked: Article | null = null;

    set((state) => {
      const key = pageKey(fileId, page);
      const ps = state.pageStates[key];
      const selection = state.selectionOrders[key] ?? [];
      if (!ps || selection.length === 0) return;

      const blockIds = selection.filter((id) =>
        ps.blocks.some((block) => block.id === id)
      );
      if (blockIds.length === 0) return;

      const doc = state.documentStates[fileId] ?? makeDocumentState();
      const selectedSet = new Set(blockIds);
      doc.articles.forEach((article) => {
        article.blockRefs = article.blockRefs.filter(
          (ref) => !(ref.page === page && selectedSet.has(ref.blockId))
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
      blockIds.forEach((blockId, index) => {
        article!.blockRefs.push({
          page,
          blockId,
          order: startOrder + index + 1,
        });
        const block = ps.blocks.find((candidate) => candidate.id === blockId);
        if (block) {
          block.articleId = article!.id;
          block.articleOrder = startOrder + index + 1;
        }
      });

      doc.articles = doc.articles.filter(
        (candidate) => candidate.blockRefs.length > 0 || candidate.id === article!.id
      );
      renumberArticles(doc);
      state.selectionOrders[key] = [];
      state.documentStates[fileId] = doc;
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

      article.blockRefs.forEach((ref) => {
        const ps = state.pageStates[pageKey(fileId, ref.page)];
        const block = ps?.blocks.find((candidate) => candidate.id === ref.blockId);
        if (block) {
          block.articleId = null;
          block.articleOrder = null;
        }
      });
      doc.articles = doc.articles.filter((candidate) => candidate.id !== articleId);
      renumberArticles(doc);
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
      doc.articles.forEach((article) => {
        article.blockRefs.forEach((ref) => {
          const ps = state.pageStates[pageKey(fileId, ref.page)];
          const block = ps?.blocks.find((candidate) => candidate.id === ref.blockId);
          if (block) {
            block.articleId = null;
            block.articleOrder = null;
          }
        });
      });
      doc.articles = [];
      state.documentStates[fileId] = doc;
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

  getPageState: (fileId, page) => {
    return get().pageStates[pageKey(fileId, page)] ?? EMPTY_PAGE_STATE;
  },

  getDocumentState: (fileId) => {
    return get().documentStates[fileId] ?? EMPTY_DOCUMENT_STATE;
  },
});
