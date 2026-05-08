/**
 * Article color palette — 10 distinct HSL hues, ported from
 * newspaper_ocr.py:149 (ARTICLE_COLORS). Each entry maps to a CSS variable
 * declared in globals.css so theme switches re-tint articles automatically.
 */
export const ARTICLE_HUES = [
  "var(--article-1)",
  "var(--article-2)",
  "var(--article-3)",
  "var(--article-4)",
  "var(--article-5)",
  "var(--article-6)",
  "var(--article-7)",
  "var(--article-8)",
  "var(--article-9)",
  "var(--article-10)",
] as const;

export function articleHue(index: number): string {
  const hue = ARTICLE_HUES[Math.abs(index) % ARTICLE_HUES.length];
  return hue ?? ARTICLE_HUES[0]!;
}

export function articleFill(index: number, alpha = 0.4): string {
  return `hsl(${articleHue(index)} / ${alpha})`;
}

export function articleStroke(index: number, alpha = 0.85): string {
  return `hsl(${articleHue(index)} / ${alpha})`;
}
