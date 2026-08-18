// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProofreadReviewPanel } from "./ProofreadReviewPanel";
import type { ProofreadReview } from "@/lib/proofread";

const {
  state,
  setSuggestionVerdict,
  setCategoryVerdict,
  applyReview,
  undoReview,
  discardReview,
  setEditingLayoutBlock,
  setFocusedRegion,
  confirmDestructive,
} = vi.hoisted(() => ({
  state: {
    recognizedPages: {} as Record<
      string,
      Record<number, { text: string; layout?: unknown }>
    >,
    pageOcrTexts: {} as Record<string, Record<number, string>>,
    articleOcrTexts: {} as Record<string, Record<string, string>>,
    editingLayoutIndex: null as number | null,
    applyResult: true,
    // Grouped reviews point the canvas at the article's own outline, which
    // is derived from these two.
    articles: [] as Array<{
      id: string;
      num: number;
      title: string;
      blockRefs: Array<{ page: number; blockId: string; order: number }>;
    }>,
    pageStates: {} as Record<string, { blocks: unknown[] }>,
  },
  setSuggestionVerdict: vi.fn(),
  setCategoryVerdict: vi.fn(),
  applyReview: vi.fn(() => true),
  undoReview: vi.fn(() => true),
  discardReview: vi.fn(),
  setEditingLayoutBlock: vi.fn(),
  setFocusedRegion: vi.fn(),
  confirmDestructive: vi.fn(async () => true),
}));

vi.mock("@/store", () => {
  const store = {
    get recognizedPages() {
      return state.recognizedPages;
    },
    get pageOcrTexts() {
      return state.pageOcrTexts;
    },
    get articleOcrTexts() {
      return state.articleOcrTexts;
    },
    setProofreadSuggestionVerdict: setSuggestionVerdict,
    setProofreadCategoryVerdict: setCategoryVerdict,
    applyProofreadReview: applyReview,
    undoProofreadReview: undoReview,
    discardProofreadReview: discardReview,
    setEditingLayoutBlock,
    setFocusedRegion,
    getEditingLayoutBlockIndex: () => state.editingLayoutIndex,
    get pageStates() {
      return state.pageStates;
    },
    getDocumentState: () => ({ articles: state.articles }),
  };
  const useStore = (selector: (s: typeof store) => unknown) => selector(store);
  useStore.getState = () => store;
  return { useStore };
});

vi.mock("@/lib/confirm", () => ({
  confirmDestructive,
}));

function review(overrides: Partial<ProofreadReview> = {}): ProofreadReview {
  return {
    target: { mode: "whole_file", page: 1 },
    baseText: "本埠新聞，巳於昨日到達。",
    suggestions: [
      {
        before: "巳",
        after: "已",
        context_before: "本埠新聞，",
        category: "charform",
        confidence: 0.9,
        reason: "形近字误识",
        verdict: "accepted",
      },
      {
        before: "到達",
        after: "抵達",
        context_before: "昨日",
        category: "semantic",
        confidence: 0.7,
        reason: "语义改写",
        verdict: "pending",
      },
    ],
    model: "gpt-4o",
    discarded: 0,
    status: "pending",
    createdAt: 1,
    ...overrides,
  };
}

function renderPanel(props: {
  fileId?: string;
  targetKey?: string;
  review?: ProofreadReview;
  onClose?: () => void;
  onReProofread?: () => void;
}) {
  return render(
    <ProofreadReviewPanel
      fileId={props.fileId ?? "file-1"}
      targetKey={props.targetKey ?? "page:1"}
      review={props.review ?? review()}
      onClose={props.onClose ?? vi.fn()}
      onReProofread={props.onReProofread ?? vi.fn()}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.recognizedPages = {
    "file-1": {
      1: { text: "本埠新聞，巳於昨日到達。" },
    },
  };
  state.pageOcrTexts = {};
  state.articleOcrTexts = {};
  state.editingLayoutIndex = null;
  state.articles = [];
  state.pageStates = {};
  state.applyResult = true;
  applyReview.mockImplementation(() => state.applyResult);
});

afterEach(cleanup);

describe("ProofreadReviewPanel — rendering", () => {
  it("renders every suggestion with its before/after diff and reason", () => {
    renderPanel({});
    expect(screen.getByText("巳")).toBeTruthy();
    expect(screen.getByText("已")).toBeTruthy();
    expect(screen.getByText("形近字误识")).toBeTruthy();
    // Category chips carry the per-category count.
    expect(screen.getByRole("button", { name: /字形\s*1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /语义\s*1/ })).toBeTruthy();
  });

  it("shows the empty state when the model proposed nothing", () => {
    renderPanel({ review: review({ suggestions: [] }) });
    expect(screen.getByText("模型没有提出修订建议，原文无需修改。")).toBeTruthy();
  });

  it("reports the dropped-anchor count", () => {
    renderPanel({ review: review({ discarded: 4 }) });
    expect(
      screen.getByText("另有 4 条建议未通过锚定校验，已丢弃。")
    ).toBeTruthy();
  });

  it("shows the error banner for a failed unit", () => {
    const onReProofread = vi.fn();
    renderPanel({
      review: review({ suggestions: [], error: "网络错误" }),
      onReProofread,
    });
    expect(screen.getByText("校对失败：网络错误")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新校对" }));
    expect(onReProofread).toHaveBeenCalled();
  });
});

describe("ProofreadReviewPanel — verdicts", () => {
  it("accept / reject buttons write verdicts", () => {
    renderPanel({});
    // Second row (index 1) is the semantic suggestion, initially pending.
    const rejectButtons = screen.getAllByRole("button", { name: "拒绝" });
    fireEvent.click(rejectButtons[1]!);
    expect(setSuggestionVerdict).toHaveBeenCalledWith(
      "file-1",
      "page:1",
      1,
      "rejected"
    );
    const acceptButtons = screen.getAllByRole("button", { name: "接受" });
    fireEvent.click(acceptButtons[1]!);
    expect(setSuggestionVerdict).toHaveBeenCalledWith(
      "file-1",
      "page:1",
      1,
      "accepted"
    );
  });

  it("a category chip flips the whole category", () => {
    renderPanel({});
    // The 字形 chip starts accept-all (default policy) → click rejects all.
    fireEvent.click(screen.getByRole("button", { name: /字形\s*1/ }));
    expect(setCategoryVerdict).toHaveBeenCalledWith(
      "file-1",
      "page:1",
      "charform",
      "rejected"
    );
  });

  it("E opens the inline editor, commits on Enter", () => {
    renderPanel({});
    fireEvent.keyDown(window, { key: "e" });
    const input = screen.getByRole("textbox", { name: "编辑" });
    fireEvent.change(input, { target: { value: "己" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setSuggestionVerdict).toHaveBeenCalledWith(
      "file-1",
      "page:1",
      0,
      "edited",
      "己"
    );
  });

  it("bare letters do nothing while the edit box has focus", () => {
    renderPanel({});
    fireEvent.keyDown(window, { key: "e" });
    const input = screen.getByRole("textbox", { name: "编辑" });
    fireEvent.keyDown(input, { key: "a" });
    expect(setSuggestionVerdict).not.toHaveBeenCalled();
  });
});

describe("ProofreadReviewPanel — keyboard navigation", () => {
  it("J / K move the selection and A / R act on it", () => {
    renderPanel({});
    // Selection starts at 0; J moves to 1.
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "a" });
    expect(setSuggestionVerdict).toHaveBeenCalledWith(
      "file-1",
      "page:1",
      1,
      "accepted"
    );
    // K back to 0, R rejects.
    fireEvent.keyDown(window, { key: "k" });
    fireEvent.keyDown(window, { key: "r" });
    expect(setSuggestionVerdict).toHaveBeenCalledWith(
      "file-1",
      "page:1",
      0,
      "rejected"
    );
  });

  it("Escape exits the review", () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ProofreadReviewPanel — apply / stale / undo", () => {
  it("applies accepted suggestions and reports the count", () => {
    renderPanel({});
    // charform accepted (1), semantic pending → 1 correction to write.
    const apply = screen.getByRole("button", { name: "写入 1 处修订" });
    fireEvent.click(apply);
    expect(applyReview).toHaveBeenCalledWith("file-1", "page:1");
  });

  it("blocks the apply path entirely when the text is stale", () => {
    state.recognizedPages = {
      "file-1": { 1: { text: "用户手动改过的文本" } },
    };
    const onReProofread = vi.fn();
    renderPanel({ onReProofread });
    expect(screen.getByText("原文已修改")).toBeTruthy();
    // The apply button stays visible but dimmed — a toolbar dims its items,
    // it does not vanish. The stale banner's two exits are the only live
    // paths.
    const apply = screen.getByRole("button", {
      name: /写入 .* 处修订/,
    }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重新校对" }));
    expect(onReProofread).toHaveBeenCalled();
  });

  it("discard confirms through the native dialog before dropping", async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.click(screen.getByRole("button", { name: "丢弃" }));
    expect(confirmDestructive).toHaveBeenCalled();
    await Promise.resolve();
    expect(discardReview).toHaveBeenCalledWith("file-1", "page:1");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows undo in the applied state and honours the post-apply edit block", () => {
    state.recognizedPages = {
      "file-1": { 1: { text: "应用后又被改过的文本" } },
    };
    renderPanel({
      review: review({
        status: "applied",
        appliedText: "本埠新聞，已於昨日到達。",
      }),
    });
    const undo = screen.getByRole("button", { name: "撤销本次校对" });
    expect((undo as HTMLButtonElement).disabled).toBe(true);
  });

  it("undo restores when the applied text still matches", () => {
    state.recognizedPages = {
      "file-1": { 1: { text: "本埠新聞，已於昨日到達。" } },
    };
    renderPanel({
      review: review({
        status: "applied",
        appliedText: "本埠新聞，已於昨日到達。",
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "撤销本次校对" }));
    expect(undoReview).toHaveBeenCalledWith("file-1", "page:1");
  });
});

describe("ProofreadReviewPanel — canvas linkage", () => {
  it("lights up the layout block containing the selected suggestion", () => {
    state.recognizedPages = {
      "file-1": {
        1: {
          text: "本埠新聞，巳於昨日到達。",
          layout: {
            index: 1,
            width: 100,
            height: 100,
            blocks: [
              {
                label: "text",
                text: "本埠新聞，巳於昨日到達。",
                bbox: [0, 0, 1, 1],
                order: 1,
              },
            ],
          },
        },
      },
    };
    renderPanel({});
    // Selection starts at 0, whose anchor lives in block 0.
    expect(setEditingLayoutBlock).toHaveBeenCalledWith("file-1", {
      page: 1,
      index: 0,
    });
  });

  it("clears the canvas highlight on unmount", () => {
    const { unmount } = renderPanel({});
    unmount();
    expect(setEditingLayoutBlock).toHaveBeenCalledWith("file-1", null);
  });

  it("clears the highlight when the selected suggestion cannot be located", () => {
    // A layout whose blocks contain none of the review's anchors: the panel
    // must drop the previous highlight rather than leave the canvas pointing
    // at a block that has nothing to do with the selected row.
    state.recognizedPages = {
      "file-1": {
        1: {
          text: "本埠新聞，巳於昨日到達。",
          layout: {
            index: 1,
            width: 100,
            height: 100,
            blocks: [
              {
                label: "text",
                text: "毫不相干的另一段文字",
                bbox: [0, 0, 1, 1],
                order: 1,
              },
            ],
          },
        },
      },
    };
    renderPanel({});
    expect(setEditingLayoutBlock).toHaveBeenCalledWith("file-1", null);
    expect(setEditingLayoutBlock).not.toHaveBeenCalledWith(
      "file-1",
      expect.objectContaining({ page: 1 })
    );
  });

  it("points at the article's outline for a grouped review", () => {
    // A grouped article is recognized as one piece, so a suggestion inside it
    // cannot be traced to a block. The article's own outline is the best
    // available answer — and one rect per page, so a report continued across
    // a page break lights up on whichever page the canvas is showing.
    state.articleOcrTexts = { "file-1": { "a-1": "本埠新聞，巳於昨日到達。" } };
    state.articles = [
      {
        id: "a-1",
        num: 1,
        title: "报道1",
        blockRefs: [
          { page: 1, blockId: "b-1", order: 1 },
          { page: 2, blockId: "b-2", order: 2 },
        ],
      },
    ];
    state.pageStates = {
      "file-1::1": {
        blocks: [
          { id: "b-1", x: 10, y: 10, w: 100, h: 100, articleId: "a-1", articleOrder: 1 },
        ],
      },
      "file-1::2": {
        blocks: [
          { id: "b-2", x: 0, y: 0, w: 50, h: 50, articleId: "a-1", articleOrder: 2 },
        ],
      },
    };
    renderPanel({
      targetKey: "article:a-1",
      review: review({ target: { mode: "grouped", articleId: "a-1" } }),
    });

    expect(setFocusedRegion).toHaveBeenCalledWith(
      "file-1",
      expect.objectContaining({
        rects: [
          expect.objectContaining({ page: 1 }),
          expect.objectContaining({ page: 2 }),
        ],
      })
    );
    // The block channel stays clear: there is no layout block to point at,
    // and a stale one would contradict the region.
    expect(setEditingLayoutBlock).toHaveBeenCalledWith("file-1", null);
  });

  it("clears the region for a grouped article whose blocks are gone", () => {
    state.articleOcrTexts = { "file-1": { "a-1": "本埠新聞，巳於昨日到達。" } };
    state.articles = [
      {
        id: "a-1",
        num: 1,
        title: "报道1",
        blockRefs: [{ page: 1, blockId: "deleted", order: 1 }],
      },
    ];
    state.pageStates = {};
    renderPanel({
      targetKey: "article:a-1",
      review: review({ target: { mode: "grouped", articleId: "a-1" } }),
    });
    expect(setFocusedRegion).toHaveBeenCalledWith("file-1", null);
  });

  it("clears the region on unmount", () => {
    const { unmount } = renderPanel({});
    unmount();
    expect(setFocusedRegion).toHaveBeenCalledWith("file-1", null);
  });
});

describe("ProofreadReviewPanel — edit cancel", () => {
  it("Escape inside the edit box cancels without committing", () => {
    renderPanel({});
    fireEvent.keyDown(window, { key: "e" });
    const input = screen.getByRole("textbox", { name: "编辑" });
    fireEvent.change(input, { target: { value: "己" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(setSuggestionVerdict).not.toHaveBeenCalled();
  });
});

describe("ProofreadReviewPanel — Escape in edge states", () => {
  it("still exits from an error review with no suggestions", () => {
    const onClose = vi.fn();
    renderPanel({
      review: review({ suggestions: [], error: "网络错误" }),
      onClose,
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("still exits from an empty review", () => {
    const onClose = vi.fn();
    renderPanel({ review: review({ suggestions: [] }), onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
