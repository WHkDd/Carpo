import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Must import after setting up globals so article-color-token can see them.
function importModule() {
  // Clear module cache to pick up fresh globals.
  vi.resetModules();
  return import("../article-color-token");
}

describe("articleHsl", () => {
  let mutationCallback: MutationCallback | null;

  beforeEach(() => {
    mutationCallback = null;
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {
      documentElement: {},
    };
    (globalThis as Record<string, unknown>).getComputedStyle = vi.fn(() => ({
      getPropertyValue: vi.fn(() => "220 18% 43%"),
    }));
    (globalThis as Record<string, unknown>).MutationObserver = vi.fn(
      (callback: MutationCallback) => {
        mutationCallback = callback;
        return {
          observe: vi.fn(),
        };
      }
    );
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
    delete (globalThis as Record<string, unknown>).getComputedStyle;
    delete (globalThis as Record<string, unknown>).MutationObserver;
  });

  it("returns hsl with alpha for a known article number", async () => {
    const { articleHsl } = await importModule();
    expect(articleHsl(1, 0.5)).toBe("hsl(220 18% 43% / 0.5)");
  });

  it("defaults alpha to 1", async () => {
    const { articleHsl } = await importModule();
    expect(articleHsl(2)).toBe("hsl(220 18% 43% / 1)");
  });

  it("caches repeated calls", async () => {
    const getPropertyValue = vi.fn(() => "145 15% 38%");
    (globalThis as Record<string, unknown>).getComputedStyle = vi.fn(() => ({
      getPropertyValue,
    }));
    const { articleHsl } = await importModule();
    articleHsl(1, 0.5);
    articleHsl(1, 0.5);
    expect(getPropertyValue).toHaveBeenCalledTimes(1);
  });

  it("cycles article numbers through the 10 token slots", async () => {
    const getPropertyValue = vi.fn(() => "220 18% 43%");
    (globalThis as Record<string, unknown>).getComputedStyle = vi.fn(() => ({
      getPropertyValue,
    }));
    const { articleHsl } = await importModule();
    articleHsl(11);
    expect(getPropertyValue).toHaveBeenCalledWith("--article-1");
  });

  it("falls back to blue-gray for missing css variable", async () => {
    (globalThis as Record<string, unknown>).getComputedStyle = vi.fn(() => ({
      getPropertyValue: vi.fn(() => ""),
    }));
    const { articleHsl } = await importModule();
    expect(articleHsl(99)).toBe("hsl(220 18% 43% / 1)");
  });

  it("clears cache and notifies subscribers when html class changes", async () => {
    const getPropertyValue = vi
      .fn()
      .mockReturnValueOnce("220 18% 43%")
      .mockReturnValueOnce("220 30% 68%");
    (globalThis as Record<string, unknown>).getComputedStyle = vi.fn(() => ({
      getPropertyValue,
    }));
    const { articleHsl, subscribeArticleColorTokens } = await importModule();
    const listener = vi.fn();

    const unsubscribe = subscribeArticleColorTokens(listener);
    expect(articleHsl(1)).toBe("hsl(220 18% 43% / 1)");

    mutationCallback?.(
      [{ type: "attributes", attributeName: "class" } as MutationRecord],
      {} as MutationObserver
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(articleHsl(1)).toBe("hsl(220 30% 68% / 1)");
    expect(getPropertyValue).toHaveBeenCalledTimes(2);

    unsubscribe();
  });
});
