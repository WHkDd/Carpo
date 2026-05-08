use std::path::PathBuf;

use serde::Serialize;

use crate::{
    error::AppResult,
    image::{load_from_disk, supported_extensions, to_png_base64},
};

#[derive(Debug, Serialize)]
pub struct RenderedPagePayload {
    pub width: u32,
    pub height: u32,
    pub png_base64: String,
}

#[tauri::command]
pub async fn load_raster_image(path: String) -> AppResult<RenderedPagePayload> {
    let path = PathBuf::from(path);
    let img = load_from_disk(&path)?;

    Ok(RenderedPagePayload {
        width: img.width(),
        height: img.height(),
        png_base64: to_png_base64(&img)?,
    })
}

#[tauri::command]
pub async fn list_supported_extensions() -> Vec<&'static str> {
    supported_extensions().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn loads_fixture_png_as_payload() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sample.png");

        let payload = load_raster_image(path.to_string()).await.unwrap();

        assert_eq!(payload.width, 64);
        assert_eq!(payload.height, 64);
        assert!(payload.png_base64.starts_with("iVBORw0KGgo"));
    }
}
