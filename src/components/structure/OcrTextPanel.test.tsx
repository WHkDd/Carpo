// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { OcrTextPanel, buildLayoutDocumentFromRecognizedPages } from "./OcrTextPanel";

const { state, copyText, saveTextFile, isTauriRuntime, alertError, exportLayoutPdf, setSettings, listProviderModels, startProofread, getSecret } =
  vi.hoisted(() => ({
    state: {
      currentFileId: "file-1" as string | null,
      recognitionMode: "whole_file" as "whole_file" | "grouped",
      documentResults: {} as Record<string, string>,
      articleOcrTexts: {} as Record<string, Record<string, string>>,
      selectedArticleIds: [] as string[],
      pageOcrTexts: {} as Record<string, Record<number, string>>,
      recognizedPages: {} as Record<string, Record<number, unknown>>,
      files: [{ id: "file-1", name: "报纸.pdf", pdfTotal: 1, currentPage: 1 }],
      articles: [] as Array<{ id: string; num: number; title: string }>,
      newspaperName: "申报",
      newspaperDate: "1945-08-15",
      credentialRevision: 0,
      settings: {
        provider: "openai" as const,
        proofread_provider: null as string | null,
        proofread_model: "",
        proofread_prompt: "",
        openai_model: "gpt-4o",
        openrouter_model: "",
        openai_compatible_base_url: "",
        openai_compatible_model: "",
        ocr_profile: "standard",
        language: "zh",
        ocr_prompt: "",
        paddle_url: "",
        paddle_model: "",
        paddle_document_options: {},
      },
      proofreadReviews: {} as Record<string, Record<string, unknown>>,
    },
    copyText: vi.fn(async () => {}),
    saveTextFile: vi.fn(
      async (_content: string, _options: { defaultName: string }) => true
    ),
    isTauriRuntime: vi.fn(() => true),
    alertError: vi.fn(async () => true),
    exportLayoutPdf: vi.fn(async () => ({})),
    setSettings: vi.fn(async () => {}),
    listProviderModels: vi.fn(
      async (_opts?: { settings?: { provider?: string } }): Promise<string[]> =>
        []
    ),
    startProofread: vi.fn(async () => ({ job_id: "job-1" })),
    getSecret: vi.fn(async () => true),
  }));

vi.mock("@/store", () => {
  const store = {
    get currentFileId() {
      return state.currentFileId;
    },
    get recognitionMode() {
      return state.recognitionMode;
    },
    get documentResults() {
      return state.documentResults;
    },
    get articleOcrTexts() {
      return state.articleOcrTexts;
    },
    get selectedArticleIds() {
      return state.selectedArticleIds;
    },
    get pageOcrTexts() {
      return state.pageOcrTexts;
    },
    get recognizedPages() {
      return state.recognizedPages;
    },
    get files() {
      return state.files;
    },
    get settings() {
      return state.settings;
    },
    get proofreadReviews() {
      return state.proofreadReviews;
    },
    get credentialRevision() {
      return state.credentialRevision;
    },
    getDocumentState: () => ({
      articles: state.articles,
      newspaperName: state.newspaperName,
      newspaperDate: state.newspaperDate,
    }),
    updateRecognizedPageText: (
      fileId: string,
      pageNum: number,
      text: string
    ) => {
      // Functional: the flush path (scheduleWriteBack → commit) goes through
      // here, and the trigger must read the flushed text back out of the
      // store (E2).
      const pages = state.recognizedPages[fileId] ??
        (state.recognizedPages[fileId] = {});
      const entry = (pages[pageNum] ?? (pages[pageNum] = {})) as {
        text?: string;
      };
      entry.text = text;
    },
    updateArticleOcrText: vi.fn(),
    updateLayoutBlockText: vi.fn(),
    setDocumentResult: vi.fn(),
    setSettings: (next: typeof state.settings) => {
      state.settings = next;
    },
    bumpCredentialRevision: () => {
      state.credentialRevision += 1;
    },
    startJob: vi.fn(),
    // The shared job slot (see `claimJobStart` in jobSlice). Idle here — the
    // panel only reads it to disable the proofread entry while a job runs.
    activeJob: null,
    jobStartClaim: null,
    claimJobStart: () => "test-owner",
    releaseJobStart: () => {},
  };
  const useStore = (selector: (s: typeof store) => unknown) => selector(store);
  useStore.getState = () => store;
  return { useStore };
});

vi.mock("@/lib/runtime", () => ({
  copyText,
  saveTextFile,
  isTauriRuntime,
  logWarn: vi.fn(async () => {}),
  logError: vi.fn(async () => {}),
}));

vi.mock("@/lib/confirm", () => ({ alertError }));

vi.mock("@/lib/tauri", () => ({
  exportLayoutPdf,
  listProviderModels,
  setSettings,
  startProofread,
  getSecret,
  renderPage: vi.fn(async () => {
    throw new Error("no renderer in this test");
  }),
  loadRasterImage: vi.fn(async () => {
    throw new Error("no renderer in this test");
  }),
}));

// Proofread capture reads the page bitmap the canvas holds; without the
// provider the hook throws on the context alone. An empty cache plus a
// render that refuses is the "no bitmap" path — the unit goes out as text
// only, which is all these cases are asserting on.
vi.mock("@/hooks/PageBitmapCacheContext", () => ({
  usePageBitmapCacheContext: () => ({
    size: 0,
    get: () => null,
    set: () => {
      throw new Error("the proofread path must never write to the bitmap LRU");
    },
    delete: () => false,
    clear: () => {},
  }),
}));


vi.mock("@/lib/desktop", () => ({
  enableNotificationsAfterUserAction: vi.fn(async () => {}),
}));

// The review view is a separate suite; here only the wiring matters. The
// mount counter makes remounts observable: the panel keeps its selection and
// edit indices in local state, so "did this remount?" is the whole question
// behind the `key` the panel is rendered with.
let reviewPanelMounts = 0;
vi.mock("./ProofreadReviewPanel", () => ({
  ProofreadReviewPanel: ({
    targetKey,
    review,
  }: {
    targetKey: string;
    review: { status: string };
  }) => {
    const [instance] = React.useState(() => ++reviewPanelMounts);
    return (
      <div
        data-testid="proofread-review"
        data-key={targetKey}
        data-status={review.status}
        data-instance={String(instance)}
      />
    );
  },
}));

// The PDF path reaches for the native save panel directly, since it writes the
// file itself rather than going through `saveTextFile`.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => "/tmp/报纸_阅读版.pdf"),
}));

// ReactMarkdown pulls in remark/rehype/KaTeX; the preview's content is not
// what these cases are about.
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

function reset() {
  state.currentFileId = "file-1";
  state.recognitionMode = "whole_file";
  state.documentResults = {};
  state.articleOcrTexts = {};
  state.selectedArticleIds = [];
  state.pageOcrTexts = {};
  state.recognizedPages = {};
  state.articles = [];
  state.proofreadReviews = {};
  state.credentialRevision = 0;
  state.settings.proofread_provider = null;
  state.settings.proofread_model = "";
  state.settings.proofread_prompt = "";
  isTauriRuntime.mockReturnValue(true);
  setSettings.mockResolvedValue(undefined);
  listProviderModels.mockResolvedValue([]);
  startProofread.mockResolvedValue({ job_id: "job-1" });
  getSecret.mockResolvedValue(true);
}

/** A recognized page carrying text and, optionally, Paddle layout. */
function page(text: string, withLayout = false) {
  return {
    text,
    ...(withLayout
      ? {
          layout: {
            index: 1,
            width: 2000,
            height: 3000,
            blocks: [{ label: "text", text, bbox: [0, 0, 10, 10], order: 1 }],
          },
        }
      : {}),
  };
}

function openExportMenu() {
  fireEvent.click(screen.getByRole("button", { name: "导出" }));
}

function openProofreadMenu() {
  fireEvent.click(screen.getByRole("button", { name: "校对" }));
}

function menuItem(name: string): HTMLButtonElement {
  return screen.getByRole("menuitem", { name }) as HTMLButtonElement;
}

describe("OcrTextPanel toolbar — copy", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  it("copies this page in whole-file mode and flips the icon back", async () => {
    vi.useFakeTimers();
    state.recognizedPages = { "file-1": { 1: page("本埠新聞") } };
    render(<OcrTextPanel />);

    const button = screen.getByRole("button", { name: "复制本页" });
    expect(button.getAttribute("disabled")).toBeNull();
    fireEvent.click(button);
    await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith("本埠新聞"));

    // Feedback is the button's own icon, announced through a live region —
    // no extra element that could widen the toolbar.
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toBe("已复制"));
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toBe(""));
    vi.useRealTimers();
  });

  it("disables copy in grouped mode until a single article is pinned", () => {
    state.recognitionMode = "grouped";
    state.articles = [{ id: "a1", num: 1, title: "甲" }];
    state.articleOcrTexts = { "file-1": { a1: "報道甲" } };
    state.documentResults = { "file-1": "全文" };
    render(<OcrTextPanel />);

    // Nothing pinned: the panel is showing the assembled full text, so
    // "copy the selected article" has no referent.
    const unpinned = screen.getByRole("button", {
      name: "复制选中报道",
    }) as HTMLButtonElement;
    expect(unpinned.disabled).toBe(true);

    cleanup();
    state.selectedArticleIds = ["a1"];
    render(<OcrTextPanel />);
    const pinned = screen.getByRole("button", {
      name: "复制选中报道",
    }) as HTMLButtonElement;
    expect(pinned.disabled).toBe(false);
  });

  it("reports a copy failure through the platform dialog", async () => {
    state.recognizedPages = { "file-1": { 1: page("文本") } };
    copyText.mockRejectedValueOnce(new Error("clipboard denied"));
    render(<OcrTextPanel />);

    fireEvent.click(screen.getByRole("button", { name: "复制本页" }));
    await waitFor(() =>
      expect(alertError).toHaveBeenCalledWith({
        title: "复制失败",
        message: "clipboard denied",
      })
    );
    // The dialog handled it, so nothing is rendered inline.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("falls back to an inline message where there is no native dialog", async () => {
    state.recognizedPages = { "file-1": { 1: page("文本") } };
    isTauriRuntime.mockReturnValue(false);
    copyText.mockRejectedValueOnce(new Error("clipboard denied"));
    alertError.mockResolvedValueOnce(false);
    render(<OcrTextPanel />);

    fireEvent.click(screen.getByRole("button", { name: "复制本页" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "复制失败：clipboard denied"
      )
    );
  });
});

describe("OcrTextPanel toolbar — export menu", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  it("names its first entry after the mode it is in", () => {
    state.recognizedPages = { "file-1": { 1: page("文本") } };
    render(<OcrTextPanel />);
    openExportMenu();
    expect(menuItem("导出本页")).toBeTruthy();
    expect(menuItem("导出所有页")).toBeTruthy();

    cleanup();
    state.recognitionMode = "grouped";
    state.recognizedPages = {};
    state.articles = [{ id: "a1", num: 1, title: "甲" }];
    state.articleOcrTexts = { "file-1": { a1: "報道甲" } };
    state.selectedArticleIds = ["a1"];
    render(<OcrTextPanel />);
    openExportMenu();
    expect(menuItem("导出选中报道")).toBeTruthy();
    expect(menuItem("导出所有报道")).toBeTruthy();
  });

  it("dims the per-article entry instead of degrading it to a full-text export", () => {
    state.recognitionMode = "grouped";
    state.articles = [{ id: "a1", num: 1, title: "甲" }];
    state.articleOcrTexts = { "file-1": { a1: "報道甲" } };
    state.documentResults = { "file-1": "全文" };
    render(<OcrTextPanel />);
    openExportMenu();

    expect(menuItem("导出选中报道").disabled).toBe(true);
    // Exporting everything is still available — that is the honest route to
    // the full text.
    expect(menuItem("导出所有报道").disabled).toBe(false);
  });

  it("exports the draft, not the store, so the last keystroke survives", async () => {
    state.recognizedPages = { "file-1": { 1: page("原文") } };
    render(<OcrTextPanel />);

    // Type into the source view without waiting out the 400 ms debounce.
    fireEvent.click(screen.getByRole("button", { name: "切换到源码" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "原文改过" },
    });

    openExportMenu();
    fireEvent.click(menuItem("导出本页"));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalledOnce());
    expect(saveTextFile.mock.calls[0]![0]).toBe("原文改过");
  });

  it("omits the reading-view PDF entry outside whole-file mode", () => {
    state.recognitionMode = "grouped";
    state.articles = [{ id: "a1", num: 1, title: "甲" }];
    state.articleOcrTexts = { "file-1": { a1: "報道甲" } };
    state.selectedArticleIds = ["a1"];
    render(<OcrTextPanel />);
    openExportMenu();

    expect(screen.queryByRole("menuitem", { name: "导出阅读版 PDF" })).toBeNull();
  });

  it("omits the reading-view PDF entry in the browser build", () => {
    isTauriRuntime.mockReturnValue(false);
    state.recognizedPages = { "file-1": { 1: page("文本", true) } };
    render(<OcrTextPanel />);
    openExportMenu();

    expect(screen.queryByRole("menuitem", { name: "导出阅读版 PDF" })).toBeNull();
  });

  it("dims the reading-view PDF entry when the page has no layout", () => {
    state.recognizedPages = { "file-1": { 1: page("文本") } };
    render(<OcrTextPanel />);
    openExportMenu();

    expect(menuItem("导出阅读版 PDF").disabled).toBe(true);
  });

  it("exports a reading-view PDF when a layout is present", async () => {
    state.recognizedPages = { "file-1": { 1: page("文本", true) } };
    render(<OcrTextPanel />);
    openExportMenu();

    const item = menuItem("导出阅读版 PDF");
    expect(item.disabled).toBe(false);
    fireEvent.click(item);
    await waitFor(() => expect(exportLayoutPdf).toHaveBeenCalledOnce());
  });

  it("disables the trigger when nothing at all can be exported", () => {
    // Browser build, one imported layout page whose blocks carry no text: the
    // panel has a block view to show, so the toolbar renders — but both
    // remaining entries are dead and the PDF entry does not exist here.
    isTauriRuntime.mockReturnValue(false);
    state.recognizedPages = { "file-1": { 1: page("", true) } };
    render(<OcrTextPanel />);
    expect(
      (screen.getByRole("button", { name: "导出" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("keeps the toolbar up on an empty page while other pages have text", () => {
    // Page 1 is blank, page 2 was recognized. Export-all must stay reachable.
    state.recognizedPages = { "file-1": { 1: page(""), 2: page("第二页") } };
    render(<OcrTextPanel />);

    openExportMenu();
    expect(menuItem("导出本页").disabled).toBe(true);
    expect(menuItem("导出所有页").disabled).toBe(false);
  });
});

describe("OcrTextPanel toolbar — proofread split button", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  function proofreadButton(): HTMLButtonElement {
    return screen.getByRole("button", { name: "校对本页" }) as HTMLButtonElement;
  }

  it("does not render without any text anywhere", () => {
    render(<OcrTextPanel />);
    // No content at all → no toolbar (and nothing to proofread).
    expect(screen.queryByRole("button", { name: "校对本页" })).toBeNull();
  });

  it("is disabled while the current page has no text", () => {
    // Another page carries text, so the toolbar exists — but the current
    // page has nothing to proofread, and the button dims rather than
    // disappearing.
    state.recognizedPages = { "file-1": { 1: page(""), 2: page("第二页") } };
    render(<OcrTextPanel />);
    expect(proofreadButton().disabled).toBe(true);
  });

  it("enables once the page has recognized text", () => {
    state.recognizedPages = { "file-1": { 1: page("本埠新聞") } };
    render(<OcrTextPanel />);
    expect(proofreadButton().disabled).toBe(false);
  });

  it("switches to the article label in grouped mode and needs a pinned article", () => {
    state.recognitionMode = "grouped";
    state.articles = [{ id: "a-1", num: 1, title: "报道1" }];
    state.articleOcrTexts = { "file-1": { "a-1": "正文" } };
    render(<OcrTextPanel />);
    const button = screen.getByRole("button", {
      name: "校对选中报道",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    cleanup();
    state.selectedArticleIds = ["a-1"];
    render(<OcrTextPanel />);
    expect(
      (screen.getByRole("button", {
        name: "校对选中报道",
      }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("has no dropdown in whole-file mode — model choice lives in settings", () => {
    state.recognizedPages = { "file-1": { 1: page("本埠新聞") } };
    render(<OcrTextPanel />);
    expect(screen.queryByRole("button", { name: "校对" })).toBeNull();
  });

  it("offers the all-articles scope in the grouped-mode dropdown", () => {
    state.recognitionMode = "grouped";
    state.articles = [{ id: "a-1", num: 1, title: "报道1" }];
    state.articleOcrTexts = { "file-1": { "a-1": "正文" } };
    render(<OcrTextPanel />);
    openProofreadMenu();
    expect(
      screen.getByRole("menuitem", { name: /校对全部报道/ })
    ).toBeTruthy();
  });

  it("auto-opens the review view when a pending review lands on this page", () => {
    state.recognizedPages = { "file-1": { 1: page("本埠新聞") } };
    state.proofreadReviews = {
      "file-1": {
        "page:1": {
          target: { mode: "whole_file", page: 1 },
          baseText: "本埠新聞",
          suggestions: [],
          model: "gpt-4o",
          discarded: 0,
          status: "pending",
          createdAt: 7,
        },
      },
    };
    render(<OcrTextPanel />);
    expect(screen.getByTestId("proofread-review")).toBeTruthy();
    // The pending marker sits next to the page control.
    expect(
      screen.getByLabelText("1 处待审阅")
    ).toBeTruthy();
  });

  it("remounts the review panel when a re-run replaces the review", () => {
    state.recognizedPages = { "file-1": { 1: page("本埠新聞") } };
    const pageReview = (createdAt: number, count: number) => ({
      "file-1": {
        "page:1": {
          target: { mode: "whole_file", page: 1 },
          baseText: "本埠新聞",
          suggestions: Array.from({ length: count }, () => ({
            before: "巳",
            after: "已",
            context_before: "",
            category: "charform",
            confidence: 0.9,
            reason: "形近字误识",
            verdict: "pending",
          })),
          model: "gpt-4o",
          discarded: 0,
          status: "pending",
          createdAt,
        },
      },
    });

    state.proofreadReviews = pageReview(7, 90);
    const { rerender } = render(<OcrTextPanel />);
    const first =
      screen.getByTestId("proofread-review").getAttribute("data-instance");

    // Same review, unrelated re-render: the panel must keep its state, or
    // every keystroke elsewhere would throw away the reviewer's position.
    rerender(<OcrTextPanel />);
    expect(
      screen.getByTestId("proofread-review").getAttribute("data-instance")
    ).toBe(first);

    // A re-run of the same target: new suggestions, so the panel's local
    // selection index (which may point at row 89) must not survive.
    state.proofreadReviews = pageReview(8, 2);
    rerender(<OcrTextPanel />);
    expect(
      screen.getByTestId("proofread-review").getAttribute("data-instance")
    ).not.toBe(first);
  });

  it("keeps an undecided review reachable after the text is emptied", () => {
    // Emptying the page leaves no text and no layout — before the review
    // counted as content of its own, the whole panel body (and the toolbar)
    // disappeared, stranding a review the queue badge still counts.
    state.recognizedPages = {
      "file-1": { 1: { ...page(""), text: "", textEdited: true } },
    };
    state.proofreadReviews = {
      "file-1": {
        "page:1": {
          target: { mode: "whole_file", page: 1 },
          baseText: "本埠新聞",
          suggestions: [],
          model: "gpt-4o",
          discarded: 0,
          status: "pending",
          createdAt: 7,
        },
      },
    };
    render(<OcrTextPanel />);
    expect(screen.getByTestId("proofread-review")).toBeTruthy();
    // …and the way back into it stays on the toolbar.
    expect(screen.getByRole("button", { name: "校对审阅" })).toBeTruthy();
  });

  it("shows the review switch in the view group once a review exists", () => {
    state.recognizedPages = { "file-1": { 1: page("本埠新聞") } };
    state.proofreadReviews = {
      "file-1": {
        "page:1": {
          target: { mode: "whole_file", page: 1 },
          baseText: "本埠新聞",
          suggestions: [],
          model: "gpt-4o",
          discarded: 0,
          status: "pending",
          createdAt: 7,
        },
      },
    };
    render(<OcrTextPanel />);
    expect(
      screen.getByRole("button", { name: "校对审阅" })
    ).toBeTruthy();
  });
});

describe("buildLayoutDocumentFromRecognizedPages — emptied pages (条 8)", () => {
  const layout = {
    index: 1,
    width: 100,
    height: 200,
    blocks: [{ label: "text", text: "删除前的旧正文", bbox: [0, 0, 1, 1] }],
  };

  it("keeps the original layout for a page the user never edited", () => {
    const doc = buildLayoutDocumentFromRecognizedPages({
      1: { text: "", layout, textEdited: false } as never,
    });
    expect(doc?.pages[0]?.blocks[0]?.text).toBe("删除前的旧正文");
  });

  it("uses the edited text when it is non-empty", () => {
    const doc = buildLayoutDocumentFromRecognizedPages({
      1: { text: "改后的正文", layout, textEdited: true } as never,
    });
    expect(doc?.pages[0]?.blocks).toEqual([
      expect.objectContaining({ text: "改后的正文" }),
    ]);
  });

  it("does not fall back to the old layout when the user emptied the page", () => {
    // 条 8 的核心诉求：全选删除后，阅读版不能再导出删除前的文字。
    const doc = buildLayoutDocumentFromRecognizedPages({
      1: { text: "", layout, textEdited: true } as never,
    });
    expect(doc?.pages[0]?.blocks).toEqual([]);
    expect(JSON.stringify(doc)).not.toContain("删除前的旧正文");
  });
});

describe("OcrTextPanel — flush before proofread (E2)", () => {
  afterEach(() => {
    // Even on failure, a leaked fake-timer clock would stall every later
    // test's waitFor in this file.
    vi.useRealTimers();
    cleanup();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });
  it("flushes the debounced edit into the proofread request", async () => {
    vi.useFakeTimers();
    state.recognizedPages = { "file-1": { 1: page("本埠新聞") } };
    render(<OcrTextPanel />);
    fireEvent.click(screen.getByRole("button", { name: "切换到源码" }));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "本埠新聞，已於昨日到達。" },
    });
    // Within the 400 ms debounce window the user hits the proofread button:
    // the flush must carry the newest text into the request.
    fireEvent.click(screen.getByRole("button", { name: "校对本页" }));
    await vi.waitFor(() => expect(startProofread).toHaveBeenCalled());
    expect(startProofread).toHaveBeenCalledWith(
      expect.objectContaining({
        units: [
          { key: "page:1", text: "本埠新聞，已於昨日到達。", images: [] },
        ],
      })
    );
    vi.useRealTimers();
  });
});
