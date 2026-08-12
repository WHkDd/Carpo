// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRasterImage, renderPage } from "@/lib/tauri";
import type { FileEntry } from "@/lib/ipc-types";
import { createPageBitmapCache } from "./usePageBitmapCache";
import { usePdfPageSync } from "./usePdfPageSync";

vi.mock("@/lib/tauri", () => ({
  loadRasterImage: vi.fn(),
  renderPage: vi.fn(),
}));

vi.mock("@/lib/runtime", () => ({ logError: vi.fn() }));

let cache = createPageBitmapCache(2);

vi.mock("./PageBitmapCacheContext", () => ({
  usePageBitmapCacheContext: () => cache,
}));

const setFilePayload = vi.fn();
const setStatusText = vi.fn();
let currentFile: FileEntry | null = null;

vi.mock("@/store", () => {
  const state = {
    get currentFileId() {
      return currentFile?.id ?? null;
    },
    get files() {
      return currentFile ? [currentFile] : [];
    },
    setFilePayload: (...args: unknown[]) => setFilePayload(...args),
    setStatusText: (...args: unknown[]) => setStatusText(...args),
  };
  return { useStore: (selector: (s: typeof state) => unknown) => selector(state) };
});

const PREVIEW_DPI = 150;

function bitmap(width: number) {
  return { blob: new Blob(["x"]), width, height: 10 };
}

beforeEach(() => {
  vi.clearAllMocks();
  cache = createPageBitmapCache(2);
  currentFile = null;
  // jsdom has no object-URL implementation.
  let seq = 0;
  globalThis.URL.createObjectURL = vi.fn(() => `blob:url-${++seq}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  currentFile = null;
});

describe("usePdfPageSync image recovery", () => {
  it("re-fetches an image whose cache entry was evicted", async () => {
    // Import an image: its bitmap goes into the shared LRU under page 1.
    const entry = cache.set("img", 1, PREVIEW_DPI, bitmap(100));
    currentFile = {
      id: "img",
      path: "/scans/page.png",
      name: "page.png",
      ext: "png",
      kind: "image",
      payload: { width: 100, height: 10, objectUrl: entry.url },
    } as FileEntry;

    // Two PDF page renders push the image out of a 2-slot LRU, which revokes
    // its object URL — the store is now holding a dead one.
    cache.set("pdf", 1, PREVIEW_DPI, bitmap(200));
    cache.set("pdf", 2, PREVIEW_DPI, bitmap(300));
    expect(cache.get("img", 1, PREVIEW_DPI)).toBeNull();

    vi.mocked(loadRasterImage).mockResolvedValue({
      blob: new Blob(["y"]),
      width: 100,
      height: 10,
    });

    renderHook(() => usePdfPageSync());

    await waitFor(() => expect(loadRasterImage).toHaveBeenCalledWith("/scans/page.png"));
    expect(renderPage).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(setFilePayload).toHaveBeenCalledWith(
        "img",
        expect.objectContaining({ objectUrl: expect.stringMatching(/^blob:/) }),
        1
      )
    );
  });

  it("leaves a live image alone but promotes it in the LRU", async () => {
    const entry = cache.set("img", 1, PREVIEW_DPI, bitmap(100));
    currentFile = {
      id: "img",
      path: "/scans/page.png",
      name: "page.png",
      ext: "png",
      kind: "image",
      payload: { width: 100, height: 10, objectUrl: entry.url },
    } as FileEntry;
    cache.set("pdf", 1, PREVIEW_DPI, bitmap(200));

    renderHook(() => usePdfPageSync());

    // Nothing to do — the URL is still live.
    expect(loadRasterImage).not.toHaveBeenCalled();
    expect(setFilePayload).not.toHaveBeenCalled();

    // ...but the hook's `cache.get` renewed the image's LRU position, so the
    // *PDF* page is now the eviction candidate rather than the image on
    // screen. This is what used to make a displayed image evict first.
    cache.set("pdf", 2, PREVIEW_DPI, bitmap(300));
    expect(cache.get("img", 1, PREVIEW_DPI)).not.toBeNull();
    expect(cache.get("pdf", 1, PREVIEW_DPI)).toBeNull();
  });

  it("reports a failed image reload instead of leaving a blank canvas", async () => {
    currentFile = {
      id: "img",
      path: "/scans/gone.png",
      name: "gone.png",
      ext: "png",
      kind: "image",
      payload: { width: 100, height: 10, objectUrl: "blob:dead" },
    } as FileEntry;

    vi.mocked(loadRasterImage).mockRejectedValue(new Error("nope"));

    renderHook(() => usePdfPageSync());

    await waitFor(() => expect(setStatusText).toHaveBeenCalled());
    expect(setFilePayload).not.toHaveBeenCalled();
  });

  it("does not retry a file the backend already refused", async () => {
    // A DNG with no embedded preview won't grow one; re-firing the IPC on every
    // activation would burn a decode and overwrite the reason being displayed.
    currentFile = {
      id: "img",
      path: "/scans/raw-only.dng",
      name: "raw-only.dng",
      ext: "dng",
      kind: "image",
      loadError: "该 DNG 没有内嵌可读的预览图，无法读取。",
    } as FileEntry;

    renderHook(() => usePdfPageSync());

    expect(loadRasterImage).not.toHaveBeenCalled();
    expect(setFilePayload).not.toHaveBeenCalled();
    expect(setStatusText).not.toHaveBeenCalled();
  });

  it("still renders PDF pages through the pdf path", async () => {
    currentFile = {
      id: "pdf",
      path: "/scans/doc.pdf",
      name: "doc.pdf",
      ext: "pdf",
      kind: "pdf",
      payload: { width: 100, height: 10, objectUrl: "blob:stale" },
      pdfTotal: 9,
      currentPage: 4,
      payloadPage: 1,
    } as FileEntry;

    vi.mocked(renderPage).mockResolvedValue({
      blob: new Blob(["z"]),
      width: 100,
      height: 10,
    });

    renderHook(() => usePdfPageSync());

    await waitFor(() =>
      expect(renderPage).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/scans/doc.pdf", page: 4 })
      )
    );
    expect(loadRasterImage).not.toHaveBeenCalled();
  });
});
