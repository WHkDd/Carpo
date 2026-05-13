use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{ipc::Response, State};

use crate::{error::AppResult, state::AppState};

#[derive(Debug, Serialize)]
pub struct PdfInfo {
    pub page_count: u32,
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderPurpose {
    Preview,
    Ocr,
}

#[tauri::command]
pub async fn get_pdf_info(path: String, state: State<'_, AppState>) -> AppResult<PdfInfo> {
    let info = state.pdf.info(PathBuf::from(path)).await?;
    Ok(PdfInfo {
        page_count: info.page_count,
        title: info.title,
    })
}

/// Returns the page bitmap as raw binary: 4 bytes width (LE u32) + 4 bytes
/// height (LE u32) + PNG bytes. The frontend wraps the PNG slice in a Blob and
/// hands the resulting object URL to Konva. This avoids the ~33% base64
/// overhead and the JSON serialization of multi-MB strings that used to wedge
/// the IPC bridge on large pages.
#[tauri::command]
pub async fn render_page(
    path: String,
    page: u32,
    dpi: u32,
    purpose: RenderPurpose,
    state: State<'_, AppState>,
) -> AppResult<Response> {
    log::info!("rendering PDF page {page} at {dpi} dpi for {purpose:?}");
    let rendered = state
        .pdf
        .render_png(PathBuf::from(path), page, dpi)
        .await?;
    let mut out = Vec::with_capacity(8 + rendered.png_bytes.len());
    out.extend_from_slice(&rendered.width.to_le_bytes());
    out.extend_from_slice(&rendered.height.to_le_bytes());
    out.extend_from_slice(&rendered.png_bytes);
    Ok(Response::new(out))
}
