use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    commands::files::RenderedPagePayload,
    error::AppResult,
    pdf::{pdf_info_with, render_page_with},
    state::AppState,
};

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
    let info = pdf_info_with(state.inner().pdfium(), &PathBuf::from(path))?;

    Ok(PdfInfo {
        page_count: info.page_count,
        title: info.title,
    })
}

#[tauri::command]
pub async fn render_page(
    path: String,
    page: u32,
    dpi: u32,
    purpose: RenderPurpose,
    state: State<'_, AppState>,
) -> AppResult<RenderedPagePayload> {
    log::info!("rendering PDF page {page} at {dpi} dpi for {purpose:?}");

    let rendered = render_page_with(state.inner().pdfium(), &PathBuf::from(path), page, dpi)?;

    Ok(RenderedPagePayload {
        width: rendered.width,
        height: rendered.height,
        png_base64: STANDARD.encode(rendered.png_bytes),
    })
}
