const cache = new Map<string, string>();
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

const TOKEN_SLOTS = 10;
const GOLDEN_ANGLE_DEG = 137.508;
// Anchor matches the hue of `--article-1` so the algorithmic continuation
// starts from a known palette member; S/L track the median of the existing
// low-chroma tokens so generated colours blend with the first 10.
const ANCHOR_HUE = 220;
const FALLBACK_TRIPLE = "220 18% 43%";

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

function readTokenTriple(slot: number): string | null {
  if (typeof document === "undefined") return null;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--article-${slot}`)
    .trim();
  return raw || null;
}

function isDarkMode(): boolean {
  if (typeof document === "undefined") return false;
  const html = document.documentElement as
    | { classList?: { contains: (s: string) => boolean } }
    | undefined;
  if (!html?.classList?.contains) return false;
  return html.classList.contains("dark");
}

/**
 * Articles 1–10 read `--article-N` (light/dark variants live in globals.css).
 * Articles 11+ generate a hue by walking the wheel with the golden angle, so
 * adjacent articles never share a colour and the palette extends to arbitrary
 * counts. Cache invalidates when `<html>` class changes (dark-mode toggle).
 */
export function articleHsl(articleNum: number, alpha = 1): string {
  initObserver();
  const n = Math.max(1, Math.trunc(articleNum) || 1);
  const cacheKey = `${n}:${alpha}`;
  const cached = cache.get(cacheKey);
  if (cached != null) return cached;

  let triple: string;
  if (n <= TOKEN_SLOTS) {
    triple = readTokenTriple(n) ?? FALLBACK_TRIPLE;
  } else {
    const dark = isDarkMode();
    const hue =
      (((ANCHOR_HUE + (n - 1) * GOLDEN_ANGLE_DEG) % 360) + 360) % 360;
    const sat = dark ? 26 : 18;
    const light = dark ? 65 : 42;
    triple = `${hue.toFixed(1)} ${sat}% ${light}%`;
  }

  const result = `hsl(${triple} / ${alpha})`;
  cache.set(cacheKey, result);
  return result;
}
