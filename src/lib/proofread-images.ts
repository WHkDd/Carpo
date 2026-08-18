/**
 * Attaching the original to a proofread request.
 *
 * Proofreading always sends the scan the text was transcribed from — there is
 * no text-only mode to fall back to by choice, because a text-only pass
 * cannot resolve a `[待核]` marker or spot a character that reads plausibly
 * but is not what the page says. What *is* a fallback is failure: if a bitmap
 * cannot be obtained or a crop cannot be encoded, that unit goes out as text
 * alone rather than taking the whole proofread down with it.
 *
 * Split in two on purpose. `planProofreadImages` is pure — it decides how
 * many images a request will carry and where they come from, which is what
 * the pre-flight cap check needs and what tests can exercise without a
 * canvas. `captureProofreadImages` does the I/O.
 */

import { t } from "@/i18n";
import { logError } from "@/lib/runtime";
import { ACTIVE_PREVIEW_DPI } from "@/lib/ocr-profile";
import { articleRectsByPage } from "@/lib/article-bbox";
import { encodeRegionAsJpegBase64, type CaptureRect } from "@/lib/capture";
import { appErrorMessage, type FileEntry } from "@/lib/ipc-types";
import { loadRasterImage, renderPage } from "@/lib/tauri";
import { proofreadKeyFor, type ProofreadTarget } from "@/lib/proofread";
import type { Article, PageState } from "@/store/pageStateSlice";
import type { PageBitmapCache } from "@/hooks/usePageBitmapCache";

/**
 * Images one request may carry. Mirrors `MAX_IMAGES` in
 * `carpo-core/src/jobs/proofread.rs`, which is the enforcing copy — this one
 * exists so the refusal is a sentence naming the batch size instead of a 400
 * from the backend after the upload.
 */
export const MAX_PROOFREAD_IMAGES = 20;

export interface ProofreadImagePlan {
  /** Proofread unit key this image belongs to (`page:12` / `article:a_x`). */
  key: string;
  page: number;
  /** `null` means the whole page. */
  crop: CaptureRect | null;
}

/** The slice of the store this needs — spelled out so the planner can be
 *  called with a fixture in tests instead of a whole store. */
export interface PlanSource {
  pageStates: Record<string, PageState>;
  getDocumentState: (fileId: string) => { articles: Article[] };
}

/**
 * Which images a set of targets will produce, in request order.
 *
 * A whole-file target is one page image. A grouped target is one crop per
 * page its blocks occupy — normally one, two for a report that runs across a
 * page break. An article whose blocks have all been deleted contributes
 * nothing, and its unit will be sent as text only.
 */
export function planProofreadImages(
  source: PlanSource,
  fileId: string,
  targets: ProofreadTarget[]
): ProofreadImagePlan[] {
  const plans: ProofreadImagePlan[] = [];
  const articles = source.getDocumentState(fileId).articles;
  for (const target of targets) {
    const key = proofreadKeyFor(target);
    if (target.mode === "whole_file") {
      plans.push({ key, page: target.page, crop: null });
      continue;
    }
    const article = articles.find(
      (candidate) => candidate.id === target.articleId
    );
    if (!article) continue;
    for (const { page, rect } of articleRectsByPage(
      article,
      source.pageStates,
      fileId
    )) {
      plans.push({ key, page, crop: rect });
    }
  }
  return plans;
}

export interface CaptureDeps {
  file: FileEntry;
  cache: PageBitmapCache;
}

/**
 * Runs the plans and returns the base64 images per unit key.
 *
 * The bitmap cache is read but never written. Writing would be the obvious
 * optimization and is exactly wrong here: the LRU revokes an entry's object
 * URL when it evicts, and a batch of 20 pages against a 12-entry cache would
 * evict the page the canvas is currently displaying — leaving the store
 * holding a dead URL and the canvas blank until `usePdfPageSync` happens to
 * run again. Reading through costs one render for a page that is not already
 * cached, and costs the canvas nothing.
 */
export async function captureProofreadImages(
  plans: ProofreadImagePlan[],
  { file, cache }: CaptureDeps
): Promise<Map<string, string[]>> {
  const byKey = new Map<string, string[]>();
  // One fetch per page, however many crops come off it.
  const blobs = new Map<number, Blob | null>();

  for (const plan of plans) {
    let blob = blobs.get(plan.page);
    if (blob === undefined) {
      blob = await pageBlob(file, plan.page, cache);
      blobs.set(plan.page, blob);
    }
    if (!blob) continue;
    try {
      const image = await encodeRegionAsJpegBase64(blob, plan.crop);
      const existing = byKey.get(plan.key);
      if (existing) existing.push(image);
      else byKey.set(plan.key, [image]);
    } catch (err) {
      // Text-only for this unit. Logged, not surfaced: the proofread still
      // runs, and a modal about a crop would be noise in the middle of an
      // action the user asked for.
      void logError(
        `proofread capture failed for ${plan.key} on page ${plan.page}: ${appErrorMessage(err)}`
      );
    }
  }
  return byKey;
}

/** The page's bitmap, from the cache when it is there and from a render when
 *  it is not. `null` on failure — the caller degrades to text only. */
async function pageBlob(
  file: FileEntry,
  page: number,
  cache: PageBitmapCache
): Promise<Blob | null> {
  const cached = cache.get(file.id, page, ACTIVE_PREVIEW_DPI);
  if (cached) return cached.blob;
  try {
    const fetched =
      file.kind === "pdf"
        ? await renderPage({
            path: file.path,
            page,
            dpi: ACTIVE_PREVIEW_DPI,
            purpose: "preview",
          })
        : await loadRasterImage(file.path);
    return fetched.blob;
  } catch (err) {
    void logError(
      `proofread capture could not load page ${page} of ${file.path}: ${appErrorMessage(err)}`
    );
    return null;
  }
}

/** The message shown when a batch would exceed the image cap. Lives here so
 *  the count and the limit are formatted in one place. */
export function tooManyImagesMessage(count: number): string {
  return t("proofread.tooManyImages", {
    count,
    max: MAX_PROOFREAD_IMAGES,
  });
}
