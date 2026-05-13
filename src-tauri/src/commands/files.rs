use std::{io::Cursor, path::PathBuf};

use ::image::ImageFormat;
use tauri::ipc::Response;

use crate::{
    error::{AppError, AppResult},
    image::{load_from_disk, supported_extensions},
};

#[tauri::command]
pub async fn load_raster_image(path: String) -> AppResult<Response> {
    let img = tokio::task::spawn_blocking(move || load_from_disk(&PathBuf::from(path)))
        .await
        .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;
    let width = img.width();
    let height = img.height();
    let png_bytes = tokio::task::spawn_blocking(move || -> AppResult<Vec<u8>> {
        let mut buf = Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png)
            .map_err(|e| AppError::Image(format!("png encode: {e}")))?;
        Ok(buf.into_inner())
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;

    let mut out = Vec::with_capacity(8 + png_bytes.len());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&png_bytes);
    Ok(Response::new(out))
}

#[tauri::command]
pub async fn list_supported_extensions() -> Vec<&'static str> {
    supported_extensions().to_vec()
}
