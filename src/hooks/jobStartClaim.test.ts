// @vitest-environment jsdom

/**
 * The three job entry points share one slot.
 *
 * Each hook keeps its own local `starting` flag, and `activeJob` is only
 * written once the start RPC *returns* — so before this claim existed, a
 * second entry point could start a job during that round trip and silently
 * overwrite the first one's `activeJob`, orphaning a paid job that could no
 * longer be cancelled. These tests hold each entry point at its key probe and
 * assert the other two are refused, then assert the slot is freed by an early
 * return (the failure mode of a leaked claim is worse than the bug: all three
 * buttons dead until restart).
 *
 * The claim's own semantics are tested against the real store in
 * `src/store/__tests__/jobSlice.test.ts`; the fake below only mirrors them so
 * the hooks can be driven.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProofreadTrigger } from "./useProofreadTrigger";
import { useWholeFileOcrTrigger } from "./useWholeFileOcrTrigger";
import { useGroupedOcrTrigger } from "./useGroupedOcrTrigger";

const {
  state,
  getSecret,
  startProofread,
  startWholeFileOcr,
  startGroupedOcr,
  confirmDestructive,
  enableNotifications,
} = vi.hoisted(() => ({
  state: {
    jobStartClaim: null as string | null,
    activeJob: null as { status: string } | null,
    claimSeq: 0,
  },
  getSecret: vi.fn(async () => true),
  startProofread: vi.fn(async () => ({ job_id: "job-p" })),
  startWholeFileOcr: vi.fn(async () => ({ job_id: "job-w" })),
  startGroupedOcr: vi.fn(async () => ({ job_id: "job-g" })),
  confirmDestructive: vi.fn(async () => true),
  enableNotifications: vi.fn(async () => {}),
}));

vi.mock("@/store", () => {
  const articles = [
    {
      id: "a-1",
      num: 1,
      title: "报道一",
      blockRefs: [{ page: 1, blockId: "b-1", order: 0 }],
    },
  ];
  const store = {
    currentFileId: "file-1",
    recognitionMode: "grouped" as const,
    files: [
      {
        id: "file-1",
        path: "/tmp/a.pdf",
        name: "a.pdf",
        ext: "pdf",
        kind: "pdf",
        pdfTotal: 2,
        currentPage: 1,
      },
    ],
    recognizedPages: {},
    pageOcrTexts: {},
    articleOcrTexts: { "file-1": { "a-1": "本埠新聞，巳於昨日到達。" } },
    selectedArticleIds: ["a-1"],
    proofreadReviews: {},
    wholeFileRange: {},
    // Key shape comes from `pageKey(fileId, page)` in pageStateSlice.
    pageStates: {
      "file-1::1": { blocks: [{ id: "b-1", x: 0, y: 0, w: 10, h: 10 }] },
    },
    settings: {
      provider: "openai",
      openai_model: "gpt-4o",
      openrouter_model: "",
      openai_compatible_base_url: "",
      openai_compatible_model: "",
      paddle_model: "",
      proofread_provider: null,
      proofread_model: "",
      proofread_prompt: "",
    },
    getDocumentState: () => ({
      articles,
      newspaperName: "申报",
      newspaperDate: "1945-08-15",
    }),
    setRecognitionMode: () => {},
    get jobStartClaim() {
      return state.jobStartClaim;
    },
    get activeJob() {
      return state.activeJob;
    },
    claimJobStart(kind: string) {
      if (state.jobStartClaim !== null) return null;
      const job = state.activeJob;
      if (job && (job.status === "running" || job.status === "cancelling")) {
        return null;
      }
      state.claimSeq += 1;
      state.jobStartClaim = `${kind}:${state.claimSeq}`;
      return state.jobStartClaim;
    },
    releaseJobStart(owner: string) {
      if (state.jobStartClaim !== owner) return;
      state.jobStartClaim = null;
    },
    startJob() {
      state.jobStartClaim = null;
      state.activeJob = { status: "running" };
    },
  };
  const useStore = (selector: (s: typeof store) => unknown) => selector(store);
  useStore.getState = () => store;
  return { useStore };
});

vi.mock("@/lib/tauri", () => ({
  getSecret,
  startProofread,
  startWholeFileOcr,
  startGroupedOcr,
  renderPage: vi.fn(async () => {
    throw new Error("no renderer in this test");
  }),
  loadRasterImage: vi.fn(async () => {
    throw new Error("no renderer in this test");
  }),
}));

vi.mock("@/lib/runtime", () => ({ logError: vi.fn(async () => {}) }));

// Proofread capture reads the page bitmap the canvas holds; without the
// provider the hook throws on the context alone. An empty cache plus a
// render that refuses is the "no bitmap" path — the unit goes out as text
// only, which is all these cases are asserting on.
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

vi.mock("@/lib/confirm", () => ({ confirmDestructive }));
vi.mock("@/lib/desktop", () => ({
  enableNotificationsAfterUserAction: enableNotifications,
}));

function useAllTriggers() {
  return {
    proofread: useProofreadTrigger(),
    whole_file: useWholeFileOcrTrigger(),
    grouped: useGroupedOcrTrigger(),
  };
}

type Entry = "proofread" | "whole_file" | "grouped";

const ipcOf: Record<Entry, ReturnType<typeof vi.fn>> = {
  proofread: startProofread,
  whole_file: startWholeFileOcr,
  grouped: startGroupedOcr,
};

function fire(
  result: { current: ReturnType<typeof useAllTriggers> },
  entry: Entry
): Promise<void> {
  const current = result.current;
  if (entry === "proofread") return current.proofread.triggerCurrent();
  if (entry === "whole_file") return current.whole_file.trigger();
  return current.grouped.trigger();
}

function errorOf(
  result: { current: ReturnType<typeof useAllTriggers> },
  entry: Entry
): string | null {
  return result.current[entry].state.error;
}

/** A key probe that hangs until the test lets it answer. */
function pendingSecret() {
  let settle: (value: boolean) => void = () => {};
  const promise = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  getSecret.mockReturnValueOnce(promise);
  return (value: boolean) => {
    settle(value);
    return promise;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.jobStartClaim = null;
  state.activeJob = null;
  state.claimSeq = 0;
  getSecret.mockResolvedValue(true);
  startProofread.mockResolvedValue({ job_id: "job-p" });
  startWholeFileOcr.mockResolvedValue({ job_id: "job-w" });
  startGroupedOcr.mockResolvedValue({ job_id: "job-g" });
  confirmDestructive.mockResolvedValue(true);
});

describe("job start claim across the three entry points", () => {
  const pairs: Array<[Entry, Entry[]]> = [
    ["proofread", ["whole_file", "grouped"]],
    ["whole_file", ["proofread", "grouped"]],
    ["grouped", ["proofread", "whole_file"]],
  ];

  it.each(pairs)(
    "a %s start in flight refuses the other entry points",
    async (holder, others) => {
      const answerSecret = pendingSecret();
      const { result } = renderHook(() => useAllTriggers());

      // Held at the key probe: the start RPC has not returned, so `activeJob`
      // is still null — exactly the window the claim exists to cover.
      const held = fire(result, holder);
      expect(state.jobStartClaim).not.toBeNull();

      for (const other of others) {
        await act(() => fire(result, other));
        expect(ipcOf[other]).not.toHaveBeenCalled();
        expect(errorOf(result, other)).toBe(
          "已有任务正在运行或正在启动，请先等待它结束"
        );
      }

      await act(async () => {
        answerSecret(true);
        await held;
      });
      expect(ipcOf[holder]).toHaveBeenCalledTimes(1);
    }
  );

  it("releases the slot when a start bails out early", async () => {
    const { result } = renderHook(() => useAllTriggers());

    getSecret.mockResolvedValueOnce(false);
    await act(() => fire(result, "proofread"));
    expect(startProofread).not.toHaveBeenCalled();
    expect(state.jobStartClaim).toBeNull();

    // The very next start must succeed — a leaked claim would deadlock all
    // three buttons with no way back short of restarting the app.
    await act(() => fire(result, "grouped"));
    expect(startGroupedOcr).toHaveBeenCalledTimes(1);
  });

  it("keeps the slot taken once the job itself is running", async () => {
    const { result } = renderHook(() => useAllTriggers());

    await act(() => fire(result, "whole_file"));
    expect(startWholeFileOcr).toHaveBeenCalledTimes(1);
    expect(state.jobStartClaim).toBeNull();
    expect(state.activeJob).toEqual({ status: "running" });

    await act(() => fire(result, "proofread"));
    expect(startProofread).not.toHaveBeenCalled();
  });
});
