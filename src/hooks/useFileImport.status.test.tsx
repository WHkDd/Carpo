// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const { loadRasterImage } = vi.hoisted(() => ({
  loadRasterImage: vi.fn(async (path: string) => {
    if (path.includes("bad")) throw new Error("broken");
    return { blob: new Blob(["x"]), width: 10, height: 10 };
  }),
}));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  listSupportedExtensions: vi.fn(async () => ["png", "pdf"]),
  loadRasterImage,
}));
vi.mock("@/lib/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime")>()),
  isTauriRuntime: () => true,
  logError: vi.fn(),
}));
vi.mock("@/hooks/PageBitmapCacheContext", () => ({
  usePageBitmapCacheContext: () => ({ set: () => ({ url: "blob:test" }) }),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import { useStore } from "@/store";
import { t } from "@/i18n";
import { useFileImport } from "./useFileImport";

const INITIAL = useStore.getState();

beforeEach(() => {
  useStore.setState(INITIAL, true);
  vi.clearAllMocks();
});
afterEach(() => useStore.setState(INITIAL, true));

describe("import status pill", () => {
  // The success line is silent now, but it still runs, and it used to
  // overwrite the reason a file in the same batch failed to load — leaving
  // the broken file sitting in the queue with no explanation anywhere.
  it("keeps the load failure visible when only some files fail", async () => {
    const { result } = renderHook(() => useFileImport());
    await act(async () => {
      await result.current.importPaths(["/tmp/bad.png", "/tmp/good.png"]);
    });
    expect(useStore.getState().statusText).toBe(
      t("import.loadFailed", { name: "bad.png" })
    );
  });
});
