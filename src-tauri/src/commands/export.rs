//! Export commands.

use tauri::async_runtime;

use crate::{
    error::{AppError, AppResult},
    layout_pdf::{self, LayoutPdfExportRequest, LayoutPdfExportResult},
};

#[tauri::command]
pub async fn export_layout_pdf(req: LayoutPdfExportRequest) -> AppResult<LayoutPdfExportResult> {
    async_runtime::spawn_blocking(move || layout_pdf::export_layout_pdf_to_path(req))
        .await
        .map_err(|e| AppError::Internal(format!("blocking join: {e}")))?
}
