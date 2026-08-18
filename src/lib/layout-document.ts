export type LayoutDocumentSource = "paddle" | "glm_ocr";

export type LayoutBBox = [number, number, number, number];
export type LayoutPoint = [number, number];

export interface LayoutBlock {
  label: string;
  text: string;
  bbox: LayoutBBox;
  polygon?: LayoutPoint[];
  order?: number;
  imageRef?: string;
  raw?: unknown;
}

export interface LayoutPage {
  index: number;
  width: number;
  height: number;
  blocks: LayoutBlock[];
  /** True when `width`/`height` were inferred by the importer rather than
   *  stated by the JSON. See `LayoutDimensions` for what that changes. */
  dimensionsApproximate?: boolean;
}

export interface RecognizedLayoutPage extends LayoutPage {
  /** True when this page was flattened from a page-level user edit instead of
   *  Paddle's original block list. */
  textEdited?: boolean;
}

export interface LayoutDocument {
  /** Reserved for future GLM-OCR adapter; Paddle is the only producer today. */
  source: LayoutDocumentSource | string;
  pages: LayoutPage[];
}

/**
 * Maps layout-block coordinates onto the canvas image.
 *
 * The two coordinate systems have nothing to do with each other. The canvas
 * draws the page at `payload.width/height` — the source bitmap's *native*
 * pixels, which is also what hand-drawn selection blocks are stored in. A
 * `LayoutBlock.bbox`, by contrast, is whatever Paddle returned, whose unit
 * depends on the DPI the page was rendered at for OCR (`OcrProfile::ocr_dpi()`,
 * 300 or 200) and has no relation to the preview bitmap's DPI.
 *
 * Both describe the same physical page, so a single ratio per axis converts
 * between them.
 */
export interface LayoutCanvasMapping {
  sx: number;
  sy: number;
}

/**
 * How far the two axis ratios may drift apart before a *measured* mapping is
 * rejected.
 *
 * The same physical page under two DPIs scales by the same factor on both
 * axes, so when both sizes are measurements, a per-axis disagreement means at
 * least one of them is not the page. The tolerance only has to absorb the
 * rounding of two independently rounded pixel sizes.
 *
 * A highlight drawn in the wrong place is worse than no highlight at all: the
 * entire value of this feature is trusting that the box is the block you are
 * editing, and one wrong answer means never trusting it again. So an
 * implausible mapping is not approximated, it is refused.
 *
 * This check does *not* apply to `dimensionsApproximate` pages — see
 * `layoutCanvasMapping`.
 */
export const LAYOUT_MAPPING_TOLERANCE = 0.02;

export interface Dimensions {
  width: number;
  height: number;
}

export interface LayoutDimensions extends Dimensions {
  /**
   * Set by the importer when the JSON stated no page size and the size had to
   * be inferred from the document's bbox extent.
   *
   * An inferred pair is not a page shape. Each side is a *lower bound* on the
   * real one — the longest extent any page's content reached along that axis,
   * and content stops short of the paper's edge — so the ratio between them
   * is noise rather than the page's aspect ratio, while each side on its own
   * is a usable bound. `layoutCanvasMapping` reads them that way.
   */
  dimensionsApproximate?: boolean;
}

/**
 * Returns the layout → canvas scale factors, or `null` when the mapping cannot
 * be trusted. Callers must treat `null` as "do not draw" rather than falling
 * back to 1:1, which would put boxes wildly off on any non-matching DPI.
 */
export function layoutCanvasMapping(
  layout: LayoutDimensions | null | undefined,
  image: Dimensions | null | undefined
): LayoutCanvasMapping | null {
  if (!layout || !image) return null;
  if (
    !(layout.width > 0) ||
    !(layout.height > 0) ||
    !(image.width > 0) ||
    !(image.height > 0)
  ) {
    return null;
  }
  if (layout.dimensionsApproximate) {
    // Both inferred sides are lower bounds on the real ones, so both ratios
    // are *upper* bounds on the one scale factor that relates the two
    // spaces. The tightest bound is the best estimate, so take the smaller.
    //
    // Pairing long-with-long and short-with-short (rather than width with
    // width) also makes this independent of the importer's guess at the
    // page's orientation: it reads that off block extents, while the bitmap
    // here is the page itself.
    //
    // The isotropy check below is deliberately skipped. Against a pair of
    // bounds it measures noise: on one real 88-page export it refused 56
    // pages outright and drew the other 32 from a page shape nothing in the
    // file supported.
    const scale = Math.min(
      Math.max(image.width, image.height) /
        Math.max(layout.width, layout.height),
      Math.min(image.width, image.height) /
        Math.min(layout.width, layout.height)
    );
    if (!Number.isFinite(scale) || scale <= 0) return null;
    return { sx: scale, sy: scale };
  }
  const sx = image.width / layout.width;
  const sy = image.height / layout.height;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null;
  if (Math.abs(sx / sy - 1) > LAYOUT_MAPPING_TOLERANCE) return null;
  return { sx, sy };
}

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Converts a `[x0, y0, x1, y1]` layout bbox into canvas-space x/y/w/h. */
export function scaleLayoutBBox(
  bbox: LayoutBBox,
  mapping: LayoutCanvasMapping
): LayoutRect {
  const [x0, y0, x1, y1] = bbox;
  // Paddle is not guaranteed to emit its corners in top-left/bottom-right
  // order, and Konva draws a negative width as nothing at all.
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  return {
    x: left * mapping.sx,
    y: top * mapping.sy,
    width: Math.abs(x1 - x0) * mapping.sx,
    height: Math.abs(y1 - y0) * mapping.sy,
  };
}

/**
 * Converts a layout polygon into the flat `[x, y, x, y, …]` array Konva's
 * `Line` takes. Returns `null` for a polygon too short to enclose anything, so
 * the caller can fall back to the bbox.
 */
export function scaleLayoutPolygon(
  polygon: LayoutPoint[] | undefined,
  mapping: LayoutCanvasMapping
): number[] | null {
  if (!polygon || polygon.length < 3) return null;
  const points: number[] = [];
  for (const [x, y] of polygon) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    points.push(x * mapping.sx, y * mapping.sy);
  }
  return points;
}

/**
 * Bounding box of a flat `[x, y, x, y, …]` point list — the format Konva's
 * `Line` takes, i.e. the output of `scaleLayoutPolygon`. The highlight itself
 * renders as a polygon where Paddle gave one, but `revealRect` needs a plain
 * rectangle, and this is the lossless conversion between the two.
 */
export function polygonBoundingRect(points: number[]): LayoutRect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let pairs = 0;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (x === undefined || y === undefined) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pairs += 1;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (pairs < 2) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export type LayoutPdfExportMode = "bbox" | "reading";

export interface LayoutPdfExportOptions {
  mode: LayoutPdfExportMode;
  includeHeader: boolean;
  includeFooter: boolean;
  includePageNumber: boolean;
  includeAsideText: boolean;
  includeFootnote: boolean;
  includeImages: boolean;
  includeTables: boolean;
  fontScale: number;
  marginScale: number;
}

export interface LayoutPdfExportRequest {
  document: LayoutDocument;
  targetPath: string;
  options: LayoutPdfExportOptions;
}

export interface LayoutPdfExportResult {
  targetPath: string;
  /** Output pages in the reflowed PDF (not source pages). */
  pageCount: number;
  warningCount: number;
  warnings: string[];
}

export interface ReadingMarkdownExportResult {
  targetPath: string;
  /** Source pages folded into the Markdown file. */
  pageCount: number;
  warningCount: number;
  warnings: string[];
}

/** Reading-version defaults: running headers/footers and side notes are page
 *  furniture and dropped; the source-file page index is kept as a citeable
 *  anchor. `mode` is retained for wire compatibility and ignored by the
 *  backend (the exporter always reflows). */
export const DEFAULT_LAYOUT_PDF_EXPORT_OPTIONS: LayoutPdfExportOptions = {
  mode: "reading",
  includeHeader: false,
  includeFooter: false,
  includePageNumber: true,
  includeAsideText: false,
  includeFootnote: true,
  includeImages: false,
  includeTables: true,
  fontScale: 1,
  marginScale: 1,
};

/** Preflight report returned by `analyze_paddle_json` / `import_paddle_json`.
 *  Mirrors `ocr::paddle_json::PaddleJsonPreflightReport` on the Rust side. */
export interface PaddleJsonPreflightReport {
  pageCount: number;
  blockCount: number;
  /** Sorted by label on the Rust side (BTreeMap), so the JSON object iteration
   *  order is stable for the UI. */
  labelCounts: Record<string, number>;
  /** Raw `model_settings` blob from the JSON, or `null` when absent. */
  modelSettings: unknown;
  markdownIgnoreLabels: string[];
  hasParsingResults: boolean;
  hasBlockBbox: boolean;
  hasBlockOrder: boolean;
  hasPolygonPoints: boolean;
  hasMarkdown: boolean;
  hasImages: boolean;
  hasOutputImages: boolean;
  /** 1-based page positions still on the bbox-estimated size after
   *  `import_paddle_json`'s best-effort dimension probe. Empty on the
   *  `analyze_paddle_json` preflight (that call never probes) unless no
   *  page had anything better than the estimate to begin with. */
  estimatedDimensionPages: number[];
  warnings: string[];
}

export interface PaddleJsonPageText {
  page: number;
  text: string;
}

export interface PaddleJsonImport {
  preflight: PaddleJsonPreflightReport;
  document: LayoutDocument;
  pageTexts: PaddleJsonPageText[];
}
