import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Must import after setting up globals so article-color-token can see them.
function importArticleHsl() {
  // Clear module cache to pick up fresh globals.
  vi.resetModules();
  return import("../article-color-token").then((m) => m.articleHsl);
}

describe("articleHsl", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).document = {
      documentElement: {},
    };
    (globalThis as Record<string, unknown>).getComputedStyle = vi.fn(() => ({
      getPropertyValue: vi.fn(() => "220 18% 43%"),
    }));
    (globalThis as Record<string, unknown>).MutationObserver = vi.fn(
      () => ({
        observe: vi.fn(),
      })
    );
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).document;
    delete (globalThis as Record<string, unknown>).getComputedStyle;
    delete (globalThis as Record<string, unknown>).MutationObserver;
  });

  it("returns hsl with alpha for a known article number", async () => {
    const articleHsl = await importArticleHsl();
    expect(articleHsl(1, 0.5)).toBe("hsl(220 18% 43% / 0.5)");
  });

  it("defaults alpha to 1", async () => {
    const articleHsl = await importArticleHsl();
    expect(articleHsl(2)).toBe("hsl(220 18% 43% / 1)");
  });

  it("caches repeated calls", async () => {
    const getPropertyValue = vi.fn(() => "145 15% 38%");
    (globalThis as Record<string, unknown>).getComputedStyle = vi.fn(() => ({
      getPropertyValue,
    }));
    const articleHsl = await importArticleHsl();
    articleHsl(1, 0.5);
    articleHsl(1, 0.5);
    expect(getPropertyValue).toHaveBeenCalledTimes(1);
  });

  it("falls back to blue-gray for missing css variable", async () => {
    (globalThis as Record<string, unknown>).getComputedStyle = vi.fn(() => ({
      getPropertyValue: vi.fn(() => ""),
    }));
    const articleHsl = await importArticleHsl();
    expect(articleHsl(99)).toBe("hsl(220 18% 43% / 1)");
  });
});
