/** Preview DPI the canvas is actually rendered at today. The OCR-grade
 *  render DPI is now owned entirely by the backend (see
 *  `OcrProfile::ocr_dpi` in Rust); the frontend only needs to tell the
 *  backend what DPI it drew at so block coordinates can be scaled
 *  correctly. The `preview_dpi` field on OCR requests is sourced from
 *  this constant. */
export const ACTIVE_PREVIEW_DPI = 150;
