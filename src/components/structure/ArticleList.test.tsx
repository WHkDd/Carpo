// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArticleList } from "./ArticleList";

const { articleHsl, colorListeners, updateArticle } = vi.hoisted(() => ({
  articleHsl: vi.fn(() => "hsl(220 18% 43% / 1)"),
  colorListeners: new Set<() => void>(),
  updateArticle: vi.fn(),
}));

vi.mock("@/lib/article-color-token", () => ({
  articleHsl,
  subscribeArticleColorTokens: (listener: () => void) => {
    colorListeners.add(listener);
    return () => colorListeners.delete(listener);
  },
}));

vi.mock("@/store", () => {
  const store = {
    currentFileId: "file-1",
    files: [{ id: "file-1", currentPage: 1 }],
    selectedArticleIds: ["article-1"],
    articleOcrTexts: {},
    getDocumentState: () => ({
      articles: [
        {
          id: "article-1",
          num: 1,
          title: "原题",
          blockRefs: [{ page: 1, blockId: "block-1", order: 1 }],
        },
      ],
    }),
    setSelectedArticleIds: vi.fn(),
    toggleArticleSelection: vi.fn(),
    clearArticleSelection: vi.fn(),
    updateArticle,
    removeArticle: vi.fn(),
    clearArticles: vi.fn(),
  };
  return { useStore: (selector: (state: typeof store) => unknown) => selector(store) };
});

describe("ArticleList title editing", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    colorListeners.clear();
  });

  function startEditing(): HTMLInputElement {
    // The row's selection cell — the list is a grid so the row can also own
    // its rename/remove commands as sibling cells.
    fireEvent.keyDown(screen.getAllByRole("gridcell")[0]!, { key: "Enter" });
    return screen.getByRole("textbox", { name: "编辑标题" });
  }

  it("does not submit Enter while an IME composition is active", () => {
    render(<ArticleList />);
    const input = startEditing();
    fireEvent.change(input, { target: { value: "标题" } });

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(updateArticle).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "编辑标题" })).toBe(input);

    fireEvent.keyDown(input, { key: "Enter", isComposing: false });
    expect(updateArticle).toHaveBeenCalledOnce();
    expect(updateArticle).toHaveBeenCalledWith("file-1", "article-1", {
      title: "标题",
    });
  });

  it("treats keyCode 229 as the WebView IME fallback", () => {
    render(<ArticleList />);
    const input = startEditing();

    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });

    expect(updateArticle).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "编辑标题" })).toBe(input);
  });

  it("re-resolves badge colours when the theme invalidates token values", () => {
    render(<ArticleList />);
    expect(articleHsl).toHaveBeenCalledTimes(1);

    act(() => {
      colorListeners.forEach((listener) => listener());
    });

    expect(articleHsl).toHaveBeenCalledTimes(2);
  });
});
