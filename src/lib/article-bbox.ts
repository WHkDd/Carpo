/**
 * Where a grouped article sits on the page.
 *
 * An article is a set of block references, and each reference names a page —
 * a report continued across a page break contributes blocks on both. So the
 * answer is never a single rectangle: it is one rectangle *per page* the
 * article touches.
 *
 * Two callers share this. Proofreading crops the page bitmap to these
 * rectangles so the model sees the article rather than the whole sheet, and
 * the review panel reveals the canvas to the one on the current page when a
 * suggestion is selected. They must agree: a crop that disagreed with the
 * highlight would show the model one thing and the user another.
 */

import type { Article, Block, PageState } from "@/store/pageStateSlice";
import { pageKey } from "@/store/pageStateSlice";
import type { CaptureRect } from "./capture";

/** How far the union of an article's blocks is grown before it is used, as a
 *  fraction of its own size. Hand-drawn blocks are traced just inside the
 *  column rules, and a crop flush against the glyphs reads as cramped — this
 *  gives the model (and the eye) the surrounding rule and gutter for
 *  context. */
export const ARTICLE_RECT_PADDING = 0.02;

export interface ArticlePageRect {
  page: number;
  rect: CaptureRect;
}

/** Union of `blocks`, or `null` when the list is empty. Blocks are stored in
 *  preview-bitmap pixels, so the result is directly usable as a crop. */
export function unionBlockRect(blocks: Block[]): CaptureRect | null {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let seen = 0;
  for (const block of blocks) {
    if (
      !Number.isFinite(block.x) ||
      !Number.isFinite(block.y) ||
      !Number.isFinite(block.w) ||
      !Number.isFinite(block.h)
    ) {
      continue;
    }
    // A block dragged right-to-left is stored with a negative size.
    const x0 = Math.min(block.x, block.x + block.w);
    const x1 = Math.max(block.x, block.x + block.w);
    const y0 = Math.min(block.y, block.y + block.h);
    const y1 = Math.max(block.y, block.y + block.h);
    left = Math.min(left, x0);
    top = Math.min(top, y0);
    right = Math.max(right, x1);
    bottom = Math.max(bottom, y1);
    seen += 1;
  }
  if (seen === 0) return null;
  const width = right - left;
  const height = bottom - top;
  if (!(width > 0) || !(height > 0)) return null;
  return { x: left, y: top, width, height };
}

/** Grows a rect by a fraction of its own size, on every side. Never clamped
 *  here — the consumers clamp against what they are drawing on (the bitmap
 *  for a crop, the stage for a reveal). */
export function padRect(
  rect: CaptureRect,
  fraction = ARTICLE_RECT_PADDING
): CaptureRect {
  const dx = rect.width * fraction;
  const dy = rect.height * fraction;
  return {
    x: rect.x - dx,
    y: rect.y - dy,
    width: rect.width + dx * 2,
    height: rect.height + dy * 2,
  };
}

/**
 * One padded rectangle per page the article occupies, in page order.
 *
 * References whose block has since been deleted are skipped rather than
 * failing the article: the text was already recognized from those blocks, and
 * losing one of several blocks should shrink the crop, not cancel the
 * proofread. An article whose blocks are *all* gone yields an empty list, and
 * the caller falls back to sending text only.
 */
export function articleRectsByPage(
  article: Article,
  pageStates: Record<string, PageState>,
  fileId: string,
  padding = ARTICLE_RECT_PADDING
): ArticlePageRect[] {
  const byPage = new Map<number, Block[]>();
  // Articles reach this through a JSON round-trip (session restore), so an
  // entry without its refs is possible. One malformed article should cost
  // that unit its crop, not abort the whole batch.
  const refs = Array.isArray(article.blockRefs) ? article.blockRefs : [];
  for (const ref of refs) {
    const state = pageStates[pageKey(fileId, ref.page)];
    const block = state?.blocks.find((candidate) => candidate.id === ref.blockId);
    if (!block) continue;
    const existing = byPage.get(ref.page);
    if (existing) existing.push(block);
    else byPage.set(ref.page, [block]);
  }

  const out: ArticlePageRect[] = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const union = unionBlockRect(byPage.get(page) ?? []);
    if (!union) continue;
    out.push({ page, rect: padRect(union, padding) });
  }
  return out;
}
