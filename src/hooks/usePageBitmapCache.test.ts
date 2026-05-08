// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPageBitmapCache,
  pageBitmapCacheKey,
  pngBase64ToBlob,
  usePageBitmapCache,
} from "./usePageBitmapCache";

describe("usePageBitmapCache", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}:${Math.random()}`);
    revokeObjectURL = vi.fn();
    vi.stubGlobal("Blob", NodeBlob);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses file/page/dpi keys", () => {
    expect(pageBitmapCacheKey("file-a", 2.9, 149.9)).toBe("file-a::2::149");
  });

  it("evicts least-recently-used entries and revokes URLs", () => {
    const cache = createPageBitmapCache(2);

    const first = cache.set("a", 1, 150, new Blob(["first"]));
    const second = cache.set("a", 2, 150, new Blob(["second"]));

    expect(cache.get("a", 1, 150)).toBe(first);
    const third = cache.set("a", 3, 150, new Blob(["third"]));

    expect(cache.size).toBe(2);
    expect(cache.get("a", 2, 150)).toBeNull();
    expect(cache.get("a", 1, 150)).toBe(first);
    expect(cache.get("a", 3, 150)).toBe(third);
    expect(revokeObjectURL).toHaveBeenCalledWith(second.url);
  });

  it("revokes all live URLs when the hook unmounts", () => {
    const { result, unmount } = renderHook(() => usePageBitmapCache(2));

    const first = result.current.set("a", 1, 150, new Blob(["first"]));
    const second = result.current.set("a", 2, 150, new Blob(["second"]));
    unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith(first.url);
    expect(revokeObjectURL).toHaveBeenCalledWith(second.url);
  });

  it("converts png base64 payloads to png blobs", async () => {
    const blob = pngBase64ToBlob("iVBORw0KGgo=");

    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await new Response(blob).arrayBuffer()).slice(0, 4)).toEqual(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    );
  });
});
