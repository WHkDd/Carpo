// @vitest-environment jsdom

/**
 * Renders the hook against the REAL zustand store — deliberately no
 * `vi.mock("@/store")`.
 *
 * zustand v5 hands the selector result straight to `useSyncExternalStore`,
 * whose snapshot must be referentially stable: a selector that builds a
 * fresh array/object on every call re-renders forever and React throws
 * "Maximum update depth exceeded" (minified error #185) — the blank-window
 * crash the first packaged build of this branch shipped with. Every other
 * suite mocks `@/store` with a plain function applied to a plain object,
 * which can never catch this class of bug; this file is the wiring net.
 * (The repo hit the same class once before — plan.md batch 3's `imageSize`
 * selector — which is exactly why the mistake deserves a permanent test.)
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProofreadTrigger } from "./useProofreadTrigger";
import { useStore } from "@/store";

vi.mock("@/lib/tauri", () => ({
  getSecret: vi.fn(async () => true),
  startProofread: vi.fn(async () => ({ job_id: "job-1" })),
  setSettings: vi.fn(async () => {}),
  renderPage: vi.fn(async () => {
    throw new Error("no renderer in this test");
  }),
  loadRasterImage: vi.fn(async () => {
    throw new Error("no renderer in this test");
  }),
}));
// The real store is the point of this file; the bitmap cache is not, and
// mounting a provider around the hook would say nothing about subscription
// stability.
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
vi.mock("@/lib/confirm", () => ({
  confirmDestructive: vi.fn(async () => true),
}));
vi.mock("@/lib/desktop", () => ({
  enableNotificationsAfterUserAction: vi.fn(async () => {}),
}));

beforeEach(() => {
  const state = useStore.getState();
  [...state.files].forEach((file) => state.removeFile(file.id));
});

describe("useProofreadTrigger against the real store", () => {
  it("mounts at boot (no file open) without a render loop", () => {
    // With an unstable subscription this line alone throws React #185 —
    // `selectAllArticleProofreadTargets` returns a fresh [] per call when
    // no file is open, which is the state the app boots in.
    const { result, rerender } = renderHook(() => useProofreadTrigger());
    expect(result.current.state.hasCurrentTarget).toBe(false);
    expect(result.current.state.allArticleTargetCount).toBe(0);
    rerender();
    expect(result.current.state.error).toBeNull();
  });

  it("stays stable once a page with text is open", () => {
    // The other half of the hazard: with a current target the selector
    // returns a fresh { mode, page } object per call.
    act(() => {
      useStore.getState().addFile({
        id: "f1",
        path: "/tmp/a.png",
        name: "a.png",
        ext: "png",
        kind: "image",
      });
      useStore.getState().setRecognitionMode("whole_file");
      useStore.getState().setPageOcrTexts("f1", { 1: "本埠新聞" });
    });
    const { result, rerender } = renderHook(() => useProofreadTrigger());
    expect(result.current.state.hasCurrentTarget).toBe(true);
    rerender();
    expect(result.current.state.hasCurrentTarget).toBe(true);
  });
});
