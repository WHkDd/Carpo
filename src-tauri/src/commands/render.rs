use std::{path::PathBuf, sync::Arc};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Response, State};
use carpo_core::{error::AppResult, state::AppState};

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
pub async fn get_pdf_info(path: String, state: State<'_, Arc<AppState>>) -> AppResult<PdfInfo> {
    let info = state.pdf.info(PathBuf::from(path)).await?;
    Ok(PdfInfo {
        page_count: info.page_count,
        title: info.title,
    })
}

/// Returns the preview-grade page bitmap as raw binary:
/// `[width:u32 LE][height:u32 LE][JPEG bytes]`. The frontend wraps the JPEG
/// slice in a Blob and hands the object URL to Konva. JPEG (vs the older
/// PNG payload) shrinks the IPC payload ~6× for the same visual quality on
/// newspaper scans and roughly halves encode CPU time.
#[tauri::command]
pub async fn render_page(
    path: String,
    page: u32,
    dpi: u32,
    purpose: RenderPurpose,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Response> {
    log::info!("rendering PDF page {page} at {dpi} dpi for {purpose:?}");
    let rendered = state.pdf.render_png(PathBuf::from(path), page, dpi).await?;
    let mut out = Vec::with_capacity(8 + rendered.bytes.len());
    out.extend_from_slice(&rendered.width.to_le_bytes());
    out.extend_from_slice(&rendered.height.to_le_bytes());
    out.extend_from_slice(&rendered.bytes);
    Ok(Response::new(out))
}
