const cache = new Map<string, string>();
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

function normalizeArticleNum(articleNum: number): number {
  const n = Math.trunc(articleNum);
  if (!Number.isFinite(n)) return 1;
  return ((Math.max(1, n) - 1) % 10) + 1;
}

function invalidate(): void {
  cache.clear();
  listeners.forEach((listener) => listener());
}

function initObserver(): void {
  if (
    observer ||
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof MutationObserver === "undefined"
  )
    return;
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && m.attributeName === "class") {
        invalidate();
        return;
      }
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

export function subscribeArticleColorTokens(listener: () => void): () => void {
  initObserver();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Read `--article-N` from computed styles and return a CSS `hsl(... / alpha)`
 * string. Results are cached; cache is cleared and subscribers are notified
 * when `<html>` class changes (dark-mode toggle).
 *
 * Article numbers cycle through the 10 token slots.
 */
export function articleHsl(articleNum: number, alpha = 1): string {
  initObserver();
  const slot = normalizeArticleNum(articleNum);
  const key = `${slot}:${alpha}`;
  const cached = cache.get(key);
  if (cached != null) return cached;

  if (typeof document === "undefined") {
    const fallback = `hsl(220 18% 43% / ${alpha})`;
    cache.set(key, fallback);
    return fallback;
  }

  const cssVar = `--article-${slot}`;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(cssVar)
    .trim();

  if (!raw) {
    const fallback = `hsl(220 18% 43% / ${alpha})`;
    cache.set(key, fallback);
    return fallback;
  }

  const result = `hsl(${raw} / ${alpha})`;
  cache.set(key, result);
  return result;
}
