# Changelog

## 0.1.7 - 2026-07-11

### Fixed

- Fixed Docker/Web PDF imports so newly uploaded files become the active file immediately and PDF page counts match the frontend contract.
- Raised the Docker/Web upload body limit to support larger PDF files.
- Fixed grouped selection deletion so deleting one selected block from a multi-selection only removes the clicked block.
- Normalized whole-file OCR progress display against the requested page range, preventing provider-reported source-document totals from leaking into the UI.
- Improved the OCR text panel header so page navigation stays on one line and per-page text counts are labelled as characters.

### Changed

- Added README screenshots for full-text OCR, selection OCR, and Paddle JSON import.
- Added a README comparison table for Desktop and Docker/Web features.
- Removed Paddle document-level batch OCR from the Desktop vs Docker/Web feature comparison table.
