use std::{io::Cursor, path::Path};

use ::image::{DynamicImage, ImageFormat};
use base64::{engine::general_purpose::STANDARD, Engine};

use crate::error::{AppError, AppResult};

const SUPPORTED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "tif", "tiff", "bmp"];

pub fn supported_extensions() -> &'static [&'static str] {
    SUPPORTED_EXTENSIONS
}

pub fn load_from_disk(path: &Path) -> AppResult<DynamicImage> {
    if !path.exists() {
        return Err(AppError::FileNotFound(path.display().to_string()));
    }

    if !path.is_file() {
        return Err(AppError::Image(format!(
            "path is not a file: {}",
            path.display()
        )));
    }

    if !is_supported_extension(path) {
        return Err(AppError::Image("unsupported format".to_string()));
    }

    ::image::open(path).map_err(|e| AppError::Image(format!("{}: {e}", path.display())))
}

pub fn to_png_base64(img: &DynamicImage) -> AppResult<String> {
    let mut png = Cursor::new(Vec::new());
    img.write_to(&mut png, ImageFormat::Png)
        .map_err(|e| AppError::Image(format!("png encode failed: {e}")))?;

    Ok(STANDARD.encode(png.into_inner()))
}

fn is_supported_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            SUPPORTED_EXTENSIONS.contains(&ext.as_str())
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsupported_extension() {
        let err = load_from_disk(Path::new("fixtures/sample.txt")).unwrap_err();
        assert!(matches!(err, AppError::FileNotFound(_)));
    }
}
