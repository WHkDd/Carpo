//! Tauri commands wrapping `ocr::paddle_json`. Two surface points:
//!
//! - `analyze_paddle_json(path)` — read the JSON and return just the preflight
//!   report. Used by the import dialog to show structural diagnostics before
//!   the user commits to writing the result into the current file. Pure
//!   file-reader — no network — so opening the dialog never costs a request.
//! - `import_paddle_json(path)` — read the JSON and return the full import.
//!   Called once the user confirms; the frontend then writes the per-page
//!   results into the normalized `recognizedPages` store. Like the preflight
//!   it makes no network call: page sizes that the JSON doesn't state are
//!   inferred document-wide from the bbox extent and flagged
//!   `dimensionsApproximate`. There used to be a best-effort probe here that
//!   fetched each page's `inputImage` header to "upgrade" those sizes; it
//!   was removed because that image is a 2000px-capped preview rather than
//!   the coordinate space the bboxes live in, so the upgrade replaced an
//!   admitted estimate with a confidently wrong number — see the module docs
//!   on `carpo_core::ocr::paddle_json`.
//!
//! The JSON read + parse runs on a blocking thread because large web-export
//! JSONs can reach tens of MB and we'd rather not stall the Tauri main thread
//! on `serde_json::from_slice`.
use std::path::PathBuf;

use tauri::async_runtime;

use carpo_core::{
    error::{AppError, AppResult},
    ocr::paddle_json::{self, PaddleJsonImport, PaddleJsonPreflightReport},
};

#[tauri::command]
pub async fn analyze_paddle_json(path: String) -> AppResult<PaddleJsonPreflightReport> {
    let import = read_import(path).await?;
    Ok(import.preflight)
}

#[tauri::command]
pub async fn import_paddle_json(path: String) -> AppResult<PaddleJsonImport> {
    read_import(path).await
}

async fn read_import(path: String) -> AppResult<PaddleJsonImport> {
    async_runtime::spawn_blocking(move || paddle_json::analyze_path(&PathBuf::from(path)))
        .await
        .map_err(|e| AppError::Internal(format!("blocking join: {e}")))?
}
