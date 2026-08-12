use std::io::Cursor;
use std::path::Path;

use ::image::{DynamicImage, ImageEncoder};

use crate::error::{AppError, AppResult};

const SUPPORTED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "tif", "tiff", "bmp", "dng", "pdf"];

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

    // DNG is a TIFF container, so `image::open` would happily open one and hand
    // back whichever sub-image the tiff decoder lands on — usually the raw CFA
    // mosaic, which renders as a green grid. Route it to the preview extractor
    // before the extension reaches the generic decoder.
    if has_extension(path, "dng") {
        return crate::dng::load_preview(path);
    }

    ::image::open(path).map_err(|e| AppError::Image(format!("{}: {e}", path.display())))
}

/// Losslessly encodes a raw RGBA8 buffer as PNG.
///
/// Split out of the clipboard command so the arithmetic below is unit
/// testable without a running Tauri app. The dimension checks are not
/// defensive padding: `width * height * 4` is attacker-adjacent input as far
/// as this process is concerned (it comes from whatever put an image on the
/// system clipboard), and computing it in `u32` would wrap on a large enough
/// screenshot and silently accept a truncated buffer.
pub fn encode_rgba_png(width: u32, height: u32, rgba: &[u8]) -> AppResult<Vec<u8>> {
    if width == 0 || height == 0 {
        return Err(AppError::Image(crate::trf!(
            "剪贴板图片尺寸无效：{}×{}",
            "clipboard image has invalid dimensions: {}x{}",
            width,
            height
        )));
    }

    let expected = (width as u64)
        .checked_mul(height as u64)
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| {
            AppError::Image(crate::trf!(
                "剪贴板图片过大：{}×{}",
                "clipboard image is too large: {}x{}",
                width,
                height
            ))
        })?;

    if rgba.len() as u64 != expected {
        return Err(AppError::Image(crate::trf!(
            "剪贴板图片数据长度不符：期望 {} 字节，实际 {} 字节",
            "clipboard image data length mismatch: expected {} bytes, got {}",
            expected,
            rgba.len()
        )));
    }

    let mut out = Vec::new();
    ::image::codecs::png::PngEncoder::new(Cursor::new(&mut out))
        .write_image(rgba, width, height, ::image::ExtendedColorType::Rgba8)
        .map_err(|e| {
            AppError::Image(crate::trf!(
                "PNG 编码失败：{}",
                "PNG encoding failed: {}",
                e
            ))
        })?;
    Ok(out)
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

fn has_extension(path: &Path, want: &str) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(want))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsupported_extension() {
        let err = load_from_disk(Path::new("fixtures/sample.txt")).unwrap_err();
        assert!(matches!(err, AppError::FileNotFound(_)));
    }

    #[test]
    fn encodes_a_2x2_rgba_buffer_losslessly() {
        // Includes a fully transparent pixel: screenshots of rounded windows
        // carry alpha, and dropping it would change what OCR sees.
        #[rustfmt::skip]
        let rgba: Vec<u8> = vec![
            255, 0, 0, 255,   0, 255, 0, 255,
            0, 0, 255, 255,   1, 2, 3, 0,
        ];
        let png = encode_rgba_png(2, 2, &rgba).unwrap();
        let decoded = ::image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), (2, 2));
        assert_eq!(decoded.into_raw(), rgba);
    }

    #[test]
    fn rejects_zero_dimensions() {
        assert!(matches!(
            encode_rgba_png(0, 4, &[]).unwrap_err(),
            AppError::Image(_)
        ));
        assert!(matches!(
            encode_rgba_png(4, 0, &[]).unwrap_err(),
            AppError::Image(_)
        ));
    }

    #[test]
    fn rejects_length_mismatch_in_both_directions() {
        assert!(matches!(
            encode_rgba_png(2, 2, &[0; 12]).unwrap_err(),
            AppError::Image(_)
        ));
        assert!(matches!(
            encode_rgba_png(2, 2, &[0; 20]).unwrap_err(),
            AppError::Image(_)
        ));
    }

    #[test]
    fn rejects_dimensions_that_would_overflow_u32_arithmetic() {
        // 65536 * 65536 * 4 overflows u32 but not the u64 we compute in, so
        // this reports a length mismatch instead of accepting a short buffer.
        let err = encode_rgba_png(65_536, 65_536, &[0; 16]).unwrap_err();
        assert!(matches!(err, AppError::Image(_)));
    }
}
