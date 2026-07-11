//! Tauri commands wrapping `ocr::paddle_json`. Two surface points:
//!
//! - `analyze_paddle_json(path)` — read the JSON and return just the preflight
//!   report. Used by the import dialog to show structural diagnostics before
//!   the user commits to writing the result into the current file.
//! - `import_paddle_json(path)` — read the JSON and return the full import
//!   payload (preflight + LayoutDocument + per-page texts). Called once the
//!   user confirms; the frontend then writes the per-page results into the
//!   normalized `recognizedPages` store.
//!
//! Both commands are pure file-readers — no network, no job runner. We do the
//! IO + JSON parse on a blocking thread because large web-export JSONs can
//! reach tens of MB and we'd rather not stall the Tauri main thread on
//! `serde_json::from_slice`.
use std::path::PathBuf;

use tauri::async_runtime;

use xcvt_core::{
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
