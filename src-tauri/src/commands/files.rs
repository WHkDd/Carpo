use std::path::PathBuf;

use tauri::ipc::Response;

use crate::{
    error::{AppError, AppResult},
    image::{load_from_disk, supported_extensions},
    pdf::encode_preview_jpeg,
};

/// Loads a raster image from disk and returns the preview-grade encode for
/// the canvas. Wire format matches `render_page`: width/height prefix +
/// JPEG bytes (see [`encode_preview_jpeg`]). The OCR pipeline reloads the
/// original file directly through `image::open`, so any alpha channel in the
/// source is preserved for OCR even though the preview drops it.
#[tauri::command]
pub async fn load_raster_image(path: String) -> AppResult<Response> {
    let img = tokio::task::spawn_blocking(move || load_from_disk(&PathBuf::from(path)))
        .await
        .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;
    let width = img.width();
    let height = img.height();
    let bytes = tokio::task::spawn_blocking(move || encode_preview_jpeg(img))
        .await
        .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;

    let mut out = Vec::with_capacity(8 + bytes.len());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&bytes);
    Ok(Response::new(out))
}

#[tauri::command]
pub async fn list_supported_extensions() -> Vec<&'static str> {
    supported_extensions().to_vec()
}
