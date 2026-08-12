//! Export commands.

use tauri::async_runtime;

use carpo_core::error::{AppError, AppResult};

use crate::layout_pdf::{
    self, LayoutPdfExportRequest, LayoutPdfExportResult, ReadingMarkdownExportResult,
};

#[tauri::command]
pub async fn export_layout_pdf(req: LayoutPdfExportRequest) -> AppResult<LayoutPdfExportResult> {
    async_runtime::spawn_blocking(move || layout_pdf::export_layout_pdf_to_path(req))
        .await
        .map_err(|e| AppError::Internal(format!("blocking join: {e}")))?
}

#[tauri::command]
pub async fn export_reading_markdown(
    req: LayoutPdfExportRequest,
) -> AppResult<ReadingMarkdownExportResult> {
    async_runtime::spawn_blocking(move || layout_pdf::export_reading_markdown_to_path(req))
        .await
        .map_err(|e| AppError::Internal(format!("blocking join: {e}")))?
}
