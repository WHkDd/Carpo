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

    decode_upright(path).map_err(|e| AppError::Image(format!("{}: {e}", path.display())))
}

/// Decodes and applies the EXIF orientation. `image::open` only decodes the
/// stored pixels, so a phone shot held upright (stored landscape, tagged
/// `Orientation=6`) would reach both the canvas and OCR lying on its side.
/// Everything downstream — preview, block rects, OCR crops — works in this
/// upright frame. An unreadable orientation tag falls back to "as stored":
/// a corrupt EXIF block shouldn't turn a decodable image into a failed import.
fn decode_upright(path: &Path) -> ::image::ImageResult<DynamicImage> {
    use ::image::{ImageDecoder, ImageReader, Limits};

    let mut decoder = ImageReader::open(path)?.into_decoder()?;
    // `into_decoder` skips the output-buffer budget that `ImageReader::decode`
    // (what `image::open` used) charges before allocating. Charge it here so
    // an oversized image still fails with a limit error instead of attempting
    // a multi-GB allocation.
    let mut limits = Limits::default();
    limits.reserve(decoder.total_bytes())?;
    decoder.set_limits(limits)?;
    let orientation = decoder
        .orientation()
        .unwrap_or(::image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);
    Ok(img)
}

/// Loads `path` upright and returns it turned a quarter turn, as PNG bytes.
///
/// The rotated copy replaces the original as the file's source, so preview
/// and OCR both read the same pixels without either one carrying a rotation
/// parameter. PNG rather than JPEG so rotating the same image repeatedly
/// never stacks compression loss; `Fast` compression because this runs while
/// the user waits and the file is a session-scoped scratch copy.
pub fn rotate_quarter_png(path: &Path, clockwise: bool) -> AppResult<Vec<u8>> {
    use ::image::codecs::png::{CompressionType, FilterType, PngEncoder};

    let img = load_from_disk(path)?;
    let rotated = if clockwise {
        img.rotate90()
    } else {
        img.rotate270()
    };
    let mut out = Vec::new();
    let encoder = PngEncoder::new_with_quality(
        Cursor::new(&mut out),
        CompressionType::Fast,
        FilterType::Adaptive,
    );
    rotated
        .write_with_encoder(encoder)
        .map_err(|e| AppError::Image(format!("rotate png encode: {e}")))?;
    Ok(out)
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

    /// A `w`×`h` JPEG, left half red and right half blue, with `app1`
    /// (a complete APP1 payload, e.g. an EXIF block) spliced in after SOI.
    /// Big flat halves so JPEG loss can't blur which side is which.
    fn test_jpeg(w: u32, h: u32, app1: Option<&[u8]>) -> Vec<u8> {
        let img = ::image::RgbImage::from_fn(w, h, |x, _| {
            if x < w / 2 {
                ::image::Rgb([255, 0, 0])
            } else {
                ::image::Rgb([0, 0, 255])
            }
        });
        let mut plain = Vec::new();
        DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut plain), ::image::ImageFormat::Jpeg)
            .unwrap();
        let Some(payload) = app1 else {
            return plain;
        };
        let seg_len = (payload.len() + 2) as u16;
        let mut out = plain[..2].to_vec(); // SOI
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&seg_len.to_be_bytes());
        out.extend_from_slice(payload);
        out.extend_from_slice(&plain[2..]);
        out
    }

    /// EXIF APP1 payload with a single Orientation entry: little-endian TIFF
    /// header, one IFD entry (tag 0x0112, SHORT, count 1, value inline).
    fn exif_orientation(orientation: u16) -> Vec<u8> {
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&[b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0]);
        payload.extend_from_slice(&0x0112u16.to_le_bytes());
        payload.extend_from_slice(&3u16.to_le_bytes());
        payload.extend_from_slice(&1u32.to_le_bytes());
        payload.extend_from_slice(&orientation.to_le_bytes());
        payload.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        payload
    }

    fn is_red(p: &::image::Rgb<u8>) -> bool {
        p.0[0] > 180 && p.0[2] < 80
    }

    fn load_temp(name: &str, bytes: &[u8]) -> ::image::RgbImage {
        let path = write_temp(name, bytes);
        let img = load_from_disk(&path).unwrap().to_rgb8();
        std::fs::remove_file(&path).ok();
        img
    }

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("carpo-image-test-{}-{name}", std::process::id()));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn applies_exif_orientation_to_portrait_phone_shot() {
        // Stored landscape 32×16, tagged "rotate 90° CW to display": the
        // stored left (red) edge must end up on top, not at the bottom.
        let img = load_temp("rot6.jpg", &test_jpeg(32, 16, Some(&exif_orientation(6))));
        assert_eq!(img.dimensions(), (16, 32));
        assert!(is_red(img.get_pixel(8, 4)));
        assert!(!is_red(img.get_pixel(8, 27)));
    }

    #[test]
    fn leaves_jpeg_without_exif_as_stored() {
        let img = load_temp("noexif.jpg", &test_jpeg(32, 16, None));
        assert_eq!(img.dimensions(), (32, 16));
        assert!(is_red(img.get_pixel(4, 8)));
    }

    #[test]
    fn rotates_a_quarter_turn_in_either_direction() {
        // 2×1: red on the left, blue on the right.
        let mut src = ::image::RgbImage::new(2, 1);
        src.put_pixel(0, 0, ::image::Rgb([255, 0, 0]));
        src.put_pixel(1, 0, ::image::Rgb([0, 0, 255]));
        let mut png = Vec::new();
        DynamicImage::ImageRgb8(src)
            .write_to(&mut Cursor::new(&mut png), ::image::ImageFormat::Png)
            .unwrap();
        let path = write_temp("rot-src.png", &png);

        let cw = ::image::load_from_memory(&rotate_quarter_png(&path, true).unwrap())
            .unwrap()
            .to_rgb8();
        let ccw = ::image::load_from_memory(&rotate_quarter_png(&path, false).unwrap())
            .unwrap()
            .to_rgb8();
        std::fs::remove_file(&path).ok();

        // Clockwise: the left edge ends up on top.
        assert_eq!(cw.dimensions(), (1, 2));
        assert_eq!(cw.get_pixel(0, 0).0, [255, 0, 0]);
        // Counter-clockwise: the left edge ends up at the bottom.
        assert_eq!(ccw.dimensions(), (1, 2));
        assert_eq!(ccw.get_pixel(0, 1).0, [255, 0, 0]);
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
