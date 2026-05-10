import type { StateCreator } from "zustand";
import type { QueueSlice } from "./queueSlice";
import type { UiSlice } from "./uiSlice";
import type { FileViewSlice } from "./fileViewSlice";
import type { SelectionSlice } from "./selectionSlice";

export interface Block {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  articleId: string | null;
  articleOrder: number | null;
}

export interface Article {
  id: string;
  num: number;
  title: string;
}

export interface PageState {
  blocks: Block[];
  articles: Article[];
  newspaperName: string;
  newspaperDate: string;
}

export const EMPTY_PAGE_STATE: PageState = Object.freeze({
  blocks: Object.freeze([]) as unknown as Block[],
  articles: Object.freeze([]) as unknown as Article[],
  newspaperName: "",
  newspaperDate: "",
}) as PageState;

function makePageState(): PageState {
  return { blocks: [], articles: [], newspaperName: "", newspaperDate: "" };
}

export interface PageStateSlice {
  pageStates: Record<string, PageState>;
  addBlock: (fileId: string, page: number, block: Block) => void;
  updateBlock: (
    fileId: string,
    page: number,
    blockId: string,
    patch: Partial<Omit<Block, "id">>
  ) => void;
  removeBlock: (fileId: string, page: number, blockId: string) => void;
  removeBlocks: (fileId: string, page: number, blockIds: string[]) => void;
  addArticle: (fileId: string, page: number, article: Article, blockIds: string[]) => void;
  removeArticle: (fileId: string, page: number, articleId: string) => void;
  updateArticle: (
    fileId: string,
    page: number,
    articleId: string,
    patch: Partial<Omit<Article, "id">>
  ) => void;
  updatePageState: (
    fileId: string,
    page: number,
    patch: Partial<PageState>
  ) => void;
  getPageState: (fileId: string, page: number) => PageState;
}

export function pageKey(fileId: string, page: number): string {
  return `${fileId}::${page}`;
}

export const createPageStateSlice: StateCreator<
  QueueSlice & UiSlice & FileViewSlice & PageStateSlice & SelectionSlice,
  [["zustand/immer", never]],
  [],
  PageStateSlice
> = (set, get) => ({
  pageStates: {},

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
    }),

  removeBlocks: (fileId, page, blockIds) =>
    set((state) => {
      const key = pageKey(fileId, page);
      const ps = state.pageStates[key];
      if (!ps) return;
      const idSet = new Set(blockIds);
      ps.blocks = ps.blocks.filter((b) => !idSet.has(b.id));
    }),

  addArticle: (fileId, page, article, blockIds) =>
    set((state) => {
      const key = pageKey(fileId, page);
      const ps = state.pageStates[key] ?? makePageState();
      ps.articles.push(article);
      blockIds.forEach((bid, i) => {
        const b = ps.blocks.find((b) => b.id === bid);
        if (b) {
          b.articleId = article.id;
          b.articleOrder = i + 1;
        }
      });
      state.pageStates[key] = ps;
    }),

  removeArticle: (fileId, page, articleId) =>
    set((state) => {
      const key = pageKey(fileId, page);
      const ps = state.pageStates[key];
      if (!ps) return;
      ps.articles = ps.articles.filter((a) => a.id !== articleId);
      ps.blocks.forEach((b) => {
        if (b.articleId === articleId) {
          b.articleId = null;
          b.articleOrder = null;
        }
      });
    }),

  updateArticle: (fileId, page, articleId, patch) =>
    set((state) => {
      const key = pageKey(fileId, page);
      const ps = state.pageStates[key];
      if (!ps) return;
      const idx = ps.articles.findIndex((a) => a.id === articleId);
      if (idx === -1) return;
      ps.articles[idx] = { ...ps.articles[idx]!, ...patch };
    }),

  updatePageState: (fileId, page, patch) =>
    set((state) => {
      const key = pageKey(fileId, page);
      const prev = state.pageStates[key] ?? makePageState();
      state.pageStates[key] = { ...prev, ...patch };
    }),

  getPageState: (fileId, page) => {
    return get().pageStates[pageKey(fileId, page)] ?? EMPTY_PAGE_STATE;
  },
});
