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
