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

describe("ProofreadReviewPanel — verdicts", () => {
  it("bare letters do nothing while the edit box has focus", () => {
    renderPanel({});
    fireEvent.keyDown(window, { key: "e" });
    const input = screen.getByRole("textbox", { name: "编辑" });
    fireEvent.keyDown(input, { key: "a" });
    expect(setSuggestionVerdict).not.toHaveBeenCalled();
  });
});

describe("ProofreadReviewPanel — apply / stale / undo", () => {
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
});

describe("ProofreadReviewPanel — canvas linkage", () => {
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
});
