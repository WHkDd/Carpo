// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProofreadTrigger } from "./useProofreadTrigger";
import {
  captureProofreadImages,
  MAX_PROOFREAD_IMAGES,
} from "@/lib/proofread-images";

const { state, getSecret, startProofread, confirmDestructive, enableNotifications } =
  vi.hoisted(() => ({
    state: {
      currentFileId: "file-1" as string | null,
      recognitionMode: "whole_file" as "whole_file" | "grouped",
      files: [
        { id: "file-1", name: "a.pdf", ext: "pdf", kind: "pdf", currentPage: 1 },
      ],
      recognizedPages: {} as Record<string, Record<number, { text: string }>>,
      pageOcrTexts: {} as Record<string, Record<number, string>>,
      articleOcrTexts: {} as Record<string, Record<string, string>>,
      selectedArticleIds: [] as string[],
      articles: [] as Array<{
        id: string;
        num: number;
        title: string;
        blockRefs: Array<{ page: number; blockId: string; order: number }>;
      }>,
      newspaperName: "申报",
      newspaperDate: "1945-08-15",
      proofreadReviews: {} as Record<string, Record<string, { status: string }>>,
      pageStates: {} as Record<string, { blocks: unknown[] }>,
      settings: {
        provider: "openai" as string,
        openai_model: "gpt-4o",
        openrouter_model: "",
        openai_compatible_base_url: "",
        openai_compatible_model: "",
        paddle_model: "",
        proofread_provider: null as string | null,
        proofread_model: "",
        proofread_prompt: "",
      },
    },
    getSecret: vi.fn(async () => true),
    startProofread: vi.fn(async () => ({ job_id: "job-1" })),
    confirmDestructive: vi.fn(async () => true),
    enableNotifications: vi.fn(async () => {}),
  }));

const { startJob } = vi.hoisted(() => ({ startJob: vi.fn() }));

vi.mock("@/store", () => {
  const store = {
    get currentFileId() {
      return state.currentFileId;
    },
    get recognitionMode() {
      return state.recognitionMode;
    },
    get files() {
      return state.files;
    },
    get recognizedPages() {
      return state.recognizedPages;
    },
    get pageOcrTexts() {
      return state.pageOcrTexts;
    },
    get articleOcrTexts() {
      return state.articleOcrTexts;
    },
    get selectedArticleIds() {
      return state.selectedArticleIds;
    },
    get proofreadReviews() {
      return state.proofreadReviews;
    },
    get pageStates() {
      return state.pageStates;
    },
    get settings() {
      return state.settings;
    },
    getDocumentState: () => ({
      articles: state.articles,
      newspaperName: state.newspaperName,
      newspaperDate: state.newspaperDate,
    }),
    startJob,
    // The shared job slot. Cross-entry behaviour lives in
    // `src/hooks/jobStartClaim.test.ts`; here the slot is always free so
    // these cases exercise the trigger's own logic.
    activeJob: null,
    jobStartClaim: null,
    claimJobStart: (kind: string) => `${kind}:test`,
    releaseJobStart: () => {},
  };
  const useStore = (selector: (s: typeof store) => unknown) => selector(store);
  useStore.getState = () => store;
  return { useStore };
});

// Capture reaches for the page bitmap the canvas already holds; with no
// provider mounted the hook would throw on the context alone. An empty cache
// plus a render that refuses is the "no bitmap available" path, which sends
// the unit as text only — exactly what these text-focused cases want.
vi.mock("./PageBitmapCacheContext", () => ({
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

vi.mock("@/lib/tauri", () => ({
  getSecret,
  startProofread,
  renderPage: vi.fn(async () => {
    throw new Error("no renderer in this test");
  }),
  loadRasterImage: vi.fn(async () => {
    throw new Error("no renderer in this test");
  }),
}));

vi.mock("@/lib/runtime", () => ({ logError: vi.fn(async () => {}) }));

// The planner stays real (the cap test depends on it); only the capture is
// stubbed, since jsdom has neither `createImageBitmap` nor a canvas encoder.
// The default is "no images", which is the text-only fallback every other
// case here expects.
vi.mock("@/lib/proofread-images", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/proofread-images")
  >();
  return {
    ...actual,
    captureProofreadImages: vi.fn(async () => new Map<string, string[]>()),
  };
});

vi.mock("@/lib/confirm", () => ({ confirmDestructive }));

vi.mock("@/lib/desktop", () => ({
  enableNotificationsAfterUserAction: enableNotifications,
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.currentFileId = "file-1";
  state.recognitionMode = "whole_file";
  state.files = [
    { id: "file-1", name: "a.pdf", ext: "pdf", kind: "pdf", currentPage: 1 },
  ];
  state.recognizedPages = {
    "file-1": { 1: { text: "本埠新聞，巳於昨日到達。" } },
  };
  state.pageOcrTexts = {};
  state.articleOcrTexts = {};
  state.selectedArticleIds = [];
  state.articles = [];
  state.proofreadReviews = {};
  state.pageStates = {};
  state.settings.provider = "openai";
  state.settings.proofread_provider = null;
  state.settings.proofread_model = "";
  state.settings.proofread_prompt = "";
  getSecret.mockResolvedValue(true);
  startProofread.mockResolvedValue({ job_id: "job-1" });
  confirmDestructive.mockResolvedValue(true);
});

describe("useProofreadTrigger", () => {
  it("starts a proofread job for the current page", async () => {
    const { result } = renderHook(() => useProofreadTrigger());
    await act(() => result.current.triggerCurrent());
    expect(startProofread).toHaveBeenCalledWith({
      file_id: "file-1",
      units: [
        { key: "page:1", text: "本埠新聞，巳於昨日到達。", images: [] },
      ],
      // The confirmed-settings snapshot rides along (E1): the backend runs
      // exactly this view, not whatever the disk write races to.
      provider: "openai",
      model: "gpt-4o",
      prompt: "",
    });
    expect(startJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "proofread",
        fileId: "file-1",
        units: [{ key: "page:1", text: "本埠新聞，巳於昨日到達。" }],
      })
    );
  });

  it("sends the confirmed proofread settings as the request snapshot", async () => {
    state.settings.proofread_provider = "openrouter";
    state.settings.proofread_model = "anthropic/claude-sonnet-4-6";
    state.settings.proofread_prompt = "自定义提示词";
    const { result } = renderHook(() => useProofreadTrigger());
    await act(() => result.current.triggerCurrent());
    expect(startProofread).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4-6",
        prompt: "自定义提示词",
      })
    );
  });

  it("rejects a Paddle-only setup before any network call", async () => {
    state.settings.provider = "paddleocr";
    const { result } = renderHook(() => useProofreadTrigger());
    await act(() => result.current.triggerCurrent());
    expect(startProofread).not.toHaveBeenCalled();
    expect(result.current.state.error).toContain("PaddleOCR");
  });

  it("rejects a missing API key", async () => {
    getSecret.mockResolvedValue(false);
    const { result } = renderHook(() => useProofreadTrigger());
    await act(() => result.current.triggerCurrent());
    expect(startProofread).not.toHaveBeenCalled();
    expect(result.current.state.error).toContain("API 密钥未找到");
  });

  it("asks through the native dialog before overwriting a pending review", async () => {
    state.proofreadReviews = {
      "file-1": { "page:1": { status: "pending" } },
    };
    confirmDestructive.mockResolvedValue(false);
    const { result } = renderHook(() => useProofreadTrigger());
    await act(() => result.current.triggerCurrent());
    expect(confirmDestructive).toHaveBeenCalled();
    expect(startProofread).not.toHaveBeenCalled();

    confirmDestructive.mockResolvedValue(true);
    await act(() => result.current.triggerCurrent());
    expect(startProofread).toHaveBeenCalled();
  });

  it("builds one unit per article with text in the all-articles scope", async () => {
    state.recognitionMode = "grouped";
    state.articles = [
      { id: "a-1", num: 1, title: "报道1", blockRefs: [] },
      { id: "a-2", num: 2, title: "报道2", blockRefs: [] },
    ];
    state.articleOcrTexts = {
      "file-1": { "a-1": "正文一", "a-2": "   " },
    };
    const { result } = renderHook(() => useProofreadTrigger());
    await act(() => result.current.triggerAllArticles());
    expect(startProofread).toHaveBeenCalledWith({
      file_id: "file-1",
      units: [{ key: "article:a-1", text: "正文一", images: [] }],
      provider: "openai",
      model: "gpt-4o",
      prompt: "",
    });
  });

  it("derives the batch targets from the live store, not the rendered closure (E2)", async () => {
    // The panel flushes its 400 ms edit debounce and *then* triggers: by the
    // time this runs, the store has the fresh texts, but the hook's
    // subscribed values still hold the pre-flush render. The freshly filled
    // article must be in the batch; the freshly emptied one must be out —
    // without rejecting the whole request.
    state.recognitionMode = "grouped";
    state.articles = [
      { id: "a-1", num: 1, title: "报道1", blockRefs: [] },
      { id: "a-2", num: 2, title: "报道2", blockRefs: [] },
    ];
    state.articleOcrTexts = {
      "file-1": { "a-1": "旧正文", "a-2": "待删空" },
    };
    const { result } = renderHook(() => useProofreadTrigger());
    // Post-flush store state: a-1 re-typed, a-2 emptied.
    state.articleOcrTexts = {
      "file-1": { "a-1": "新填正文", "a-2": "" },
    };
    await act(() => result.current.triggerAllArticles());
    expect(startProofread).toHaveBeenCalledWith(
      expect.objectContaining({
        units: [{ key: "article:a-1", text: "新填正文", images: [] }],
      })
    );
  });

  it("sends the captured images but keeps them out of the job record", async () => {
    // The job record is mirrored into sessionStorage (`savePendingJob`) so a
    // refreshed tab can still match the `done` event. Only key and text are
    // ever read back, while the images are megabytes of base64 — past the
    // storage quota, which would fail the write and lose reconciliation.
    vi.mocked(captureProofreadImages).mockResolvedValueOnce(
      new Map([["page:1", ["QUJD"]]])
    );
    const { result } = renderHook(() => useProofreadTrigger());
    await act(() => result.current.triggerCurrent());

    expect(startProofread).toHaveBeenCalledWith(
      expect.objectContaining({
        units: [
          { key: "page:1", text: "本埠新聞，巳於昨日到達。", images: ["QUJD"] },
        ],
      })
    );
    expect(startJob).toHaveBeenCalledWith(
      expect.objectContaining({
        units: [{ key: "page:1", text: "本埠新聞，巳於昨日到達。" }],
      })
    );
  });

  it("refuses a batch that would exceed the image cap, before capturing anything", async () => {
    // Proofreading always attaches the scan, so a whole-document batch runs
    // into the image cap (20) long before the unit cap (200). The refusal
    // has to happen here — encoding 21 crops and then having the backend
    // reject the upload would waste the wait and the memory.
    const count = MAX_PROOFREAD_IMAGES + 1;
    state.recognitionMode = "grouped";
    state.articles = Array.from({ length: count }, (_, i) => ({
      id: `a-${i}`,
      num: i + 1,
      title: `报道${i + 1}`,
      blockRefs: [{ page: 1, blockId: `b-${i}`, order: 1 }],
    }));
    state.articleOcrTexts = {
      "file-1": Object.fromEntries(
        state.articles.map((a) => [a.id, "正文"])
      ),
    };
    state.pageStates = {
      "file-1::1": {
        blocks: Array.from({ length: count }, (_, i) => ({
          id: `b-${i}`,
          x: 0,
          y: 0,
          w: 100,
          h: 100,
          articleId: null,
          articleOrder: null,
        })),
      },
    };

    const { result } = renderHook(() => useProofreadTrigger());
    await act(() => result.current.triggerAllArticles());
    expect(captureProofreadImages).not.toHaveBeenCalled();
    expect(startProofread).not.toHaveBeenCalled();
    expect(result.current.state.error).toContain(String(count));
    expect(result.current.state.error).toContain(
      String(MAX_PROOFREAD_IMAGES)
    );
  });

  it("reads the current target fresh after the store changed (E2)", async () => {
    const { result } = renderHook(() => useProofreadTrigger());
    // The page is emptied after the hook rendered: the stale closure would
    // still send the old text; the fresh read refuses with the no-text error
    // instead of starting a wasted job.
    state.recognizedPages = { "file-1": { 1: { text: "   " } } };
    await act(() => result.current.triggerCurrent());
    expect(startProofread).not.toHaveBeenCalled();
    expect(result.current.state.error).toContain("没有识别文本");
  });
});
