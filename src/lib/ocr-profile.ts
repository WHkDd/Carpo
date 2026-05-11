import type { OcrProfile } from "@/lib/ipc-types";

/**
 * DPI mapping per OCR profile. Mirrors the Python reference in
 * `newspaper_ocr.py:159-175`:
 * - 标准 (standard): preview 150, OCR 300
 * - 快速 (fast): preview 120, OCR 200
 *
 * The Tauri preview pipeline currently hardcodes 150 DPI (see
 * `usePdfPageSync.PDF_PREVIEW_DPI`), so switching to the fast profile only
 * changes the OCR-grade re-render today — preview rendering does not yet
 * react to the profile. That's parity enough for T5.7's purpose: the
 * grouped-OCR backend receives the right `preview_dpi` so its scale
 * factor matches the actual preview the user drew on.
 */
export const PROFILE_DPI: Record<OcrProfile, { preview: number; ocr: number }> = {
  standard: { preview: 150, ocr: 300 },
  fast: { preview: 120, ocr: 200 },
};

/** Preview DPI the canvas is actually rendered at today. Until the preview
 *  pipeline reacts to `OcrProfile` this stays pinned to standard. Surfaced
 *  here so backend-bound request constructors don't reach into the hook. */
export const ACTIVE_PREVIEW_DPI = 150;
