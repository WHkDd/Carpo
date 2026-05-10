const cache = new Map<string, string>();
let observer: MutationObserver | null = null;

function initObserver(): void {
  if (observer || typeof window === "undefined" || typeof document === "undefined")
    return;
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && m.attributeName === "class") {
        cache.clear();
        return;
      }
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

/**
 * Read `--article-N` from computed styles and return a CSS `hsl(... / alpha)`
 * string. Results are cached; cache is cleared when `<html>` class changes
 * (dark-mode toggle).
 *
 * Falls back to a blue-gray for out-of-range article numbers.
 */
export function articleHsl(articleNum: number, alpha = 1): string {
  initObserver();
  const key = `${articleNum}:${alpha}`;
  const cached = cache.get(key);
  if (cached != null) return cached;

  if (typeof document === "undefined") {
    const fallback = `hsl(220 18% 43% / ${alpha})`;
    cache.set(key, fallback);
    return fallback;
  }

  const cssVar = `--article-${articleNum}`;
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
