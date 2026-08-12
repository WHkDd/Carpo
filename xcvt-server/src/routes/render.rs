use std::path::PathBuf;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use xcvt_core::{
    error::AppError,
    jobs::grouped::FileKind,
    pdf::{clamp_preview_dimensions, encode_preview_jpeg},
};

use crate::{app_state::ServerState, error::ServerResult};

#[derive(Debug, Serialize)]
pub struct PdfInfo {
    pub page_count: u32,
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RenderQuery {
    pub dpi: Option<u32>,
    pub purpose: Option<String>,
}

pub async fn pdf_info(
    State(state): State<ServerState>,
    Path(file_id): Path<Uuid>,
) -> ServerResult<Json<PdfInfo>> {
    let record = file_record(&state, file_id)?;
    if record.kind != FileKind::Pdf {
        return Err(AppError::Pdf("file is not a PDF".into()).into());
    }
    let info = state.core.pdf.info(record.path).await?;
    Ok(Json(PdfInfo {
        page_count: info.page_count,
        title: info.title,
    }))
}

pub async fn render_page(
    State(state): State<ServerState>,
    Path((file_id, page)): Path<(Uuid, u32)>,
    Query(query): Query<RenderQuery>,
) -> ServerResult<Response> {
    let record = file_record(&state, file_id)?;
    if record.kind != FileKind::Pdf {
        return Err(AppError::Pdf("file is not a PDF".into()).into());
    }
    let dpi = query.dpi.unwrap_or(150);
    let _purpose = query.purpose.as_deref().unwrap_or("preview");
    let rendered = state.core.pdf.render_png(record.path, page, dpi).await?;
    Ok(binary_image_response(pack_image(
        rendered.width,
        rendered.height,
        rendered.bytes,
    )))
}

pub async fn raster(
    State(_state): State<ServerState>,
    Path(_file_id): Path<Uuid>,
) -> ServerResult<Response> {
    let record = file_record(&_state, _file_id)?;
    if record.kind != FileKind::Image {
        return Err(AppError::Image("file is not a raster image".into()).into());
    }
    let path: PathBuf = record.path;
    let img = tokio::task::spawn_blocking(move || xcvt_core::image::load_from_disk(&path))
        .await
        .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;
    let width = img.width();
    let height = img.height();
    // Native width/height, clamped bitmap — see `load_raster_image` in the
    // Tauri command of the same shape for why the two must disagree.
    let bytes =
        tokio::task::spawn_blocking(move || encode_preview_jpeg(clamp_preview_dimensions(img)))
            .await
            .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;
    Ok(binary_image_response(pack_image(width, height, bytes)))
}

fn file_record(state: &ServerState, file_id: Uuid) -> ServerResult<crate::app_state::FileRecord> {
    state
        .file(file_id)
        .ok_or_else(|| AppError::FileNotFound(file_id.to_string()).into())
}

fn pack_image(width: u32, height: u32, bytes: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + bytes.len());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&bytes);
    out
}

fn binary_image_response(bytes: Vec<u8>) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    (StatusCode::OK, headers, Body::from(bytes)).into_response()
}
