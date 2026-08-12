//! Reader for Apple ProRAW DNGs — pulls the embedded preview, not the mosaic.
//!
//! A DNG is a TIFF container: IFD0, plus a tree of SubIFDs (tag 330) holding
//! the raw CFA mosaic alongside one or more camera-rendered JPEG previews.
//! This module walks that tree and hands the largest preview to the ordinary
//! JPEG decoder. iPhone ProRAW writes a full-sensor-resolution preview into
//! IFD0 (8064x6048 on a 48MP capture) and the lossy mosaic into a SubIFD.
//!
//! **Scope is deliberately one writer.** Files from other cameras and from
//! Adobe DNG Converter are refused by name rather than attempted, because the
//! preview they embed is a setting rather than a guarantee: DNG Converter's
//! "Medium Size" option produces a 1024px preview, which for a broadsheet page
//! is about 7 pixels per character. Nothing downstream can recover from that —
//! for images `grouped::page_scale` is 1.0 and the OCR profile's DPI does not
//! apply, so the preview resolution *is* the recognition resolution. A vision
//! model handed an illegible page does not return blanks, it returns fluent
//! invented text, and there is no confidence signal to catch it with. Refusing
//! the file is the only honest option.
//!
//! We also do not develop the mosaic. That means demosaic + white balance +
//! colour matrix + tone curve, and every Rust crate that implements it
//! (`rawloader`, `imagepipe`, `rawler`, `dng`) is LGPL or AGPL — linking one
//! into this statically-linked binary would relicense an MIT app. For a
//! photographed document the camera's own preview is better anyway: it is what
//! the user framed and reviewed, it decodes in milliseconds instead of seconds,
//! and its rendering is tuned for legibility.

use std::path::Path;

use ::image::{DynamicImage, ImageFormat};

use crate::error::{AppError, AppResult};

/// The only `Make` this module accepts, matched case-insensitively against
/// IFD0 tag 271. iPhone ProRAW writes exactly `Apple`.
const SUPPORTED_MAKE: &str = "Apple";

/// Backstop under the [`SUPPORTED_MAKE`] gate. ProRAW previews are always
/// full-sensor, so this should never fire — it exists so that a future iOS that
/// starts embedding thumbnails fails loudly instead of quietly feeding 256px
/// pages to a model that will invent text for them.
const MIN_PREVIEW_LONG_EDGE: u32 = 1024;

/// Refuse to buffer absurd files whole. The largest DNGs in circulation
/// (100MP medium format, uncompressed) sit around 250 MB.
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// A single IFD carries at most a few dozen tags in practice; anything past
/// this is a corrupt or hostile header rather than a real directory.
const MAX_IFD_ENTRIES: u32 = 4096;

/// SubIFD nesting is one level deep in every DNG spec revision. Allow a little
/// slack, then stop — this bounds the recursion on untrusted input.
const MAX_IFD_DEPTH: u8 = 4;

// TIFF/DNG tags we care about.
const TAG_IMAGE_WIDTH: u16 = 256;
const TAG_IMAGE_LENGTH: u16 = 257;
const TAG_COMPRESSION: u16 = 259;
const TAG_PHOTOMETRIC: u16 = 262;
const TAG_MAKE: u16 = 271;
const TAG_STRIP_OFFSETS: u16 = 273;
const TAG_ORIENTATION: u16 = 274;
const TAG_STRIP_BYTE_COUNTS: u16 = 279;
const TAG_SUB_IFDS: u16 = 330;
const TAG_JPEG_OFFSET: u16 = 513;
const TAG_JPEG_LENGTH: u16 = 514;

const COMPRESSION_OLD_JPEG: u32 = 6;
const COMPRESSION_JPEG: u32 = 7;

const PHOTOMETRIC_RGB: u32 = 2;
const PHOTOMETRIC_YCBCR: u32 = 6;

/// Decodes the best embedded preview in `path` and applies the file's EXIF
/// orientation, so a page shot in portrait comes back upright.
pub fn load_preview(path: &Path) -> AppResult<DynamicImage> {
    let len = std::fs::metadata(path)
        .map_err(|e| AppError::Image(format!("{}: {e}", path.display())))?
        .len();
    if len > MAX_FILE_BYTES {
        return Err(AppError::Image(crate::trf!(
            "DNG 文件过大（{} MB）",
            "DNG file is too large ({} MB)",
            len / (1024 * 1024)
        )));
    }
    let buf =
        std::fs::read(path).map_err(|e| AppError::Image(format!("{}: {e}", path.display())))?;
    decode_preview(&buf)
}

/// Split from [`load_preview`] so the parser can be exercised on in-memory
/// fixtures without touching the filesystem.
fn decode_preview(buf: &[u8]) -> AppResult<DynamicImage> {
    let tiff = Tiff::new(buf).ok_or_else(|| {
        AppError::Image(crate::tr!("不是有效的 DNG 文件", "not a valid DNG file").to_string())
    })?;

    // IFD0 answers both "who wrote this" and "which way is up"; read it once.
    let ifd0 = read_ifd(&tiff, tiff.first_ifd).unwrap_or_default();

    let make = tiff.ascii(&ifd0, TAG_MAKE).unwrap_or_default();
    if !make.trim().eq_ignore_ascii_case(SUPPORTED_MAKE) {
        return Err(AppError::Image(crate::trf!(
            "目前只支持 iPhone 原生 DNG（ProRAW）。这个文件来自「{}」，请先转成 JPEG 或 TIFF 再导入。",
            "Only native iPhone DNG (ProRAW) is supported. This file came from \"{}\" — convert it to JPEG or TIFF before importing.",
            if make.trim().is_empty() { "未知来源" } else { make.trim() }
        )));
    }

    let mut previews = Vec::new();
    let mut visited = Vec::new();
    tiff.collect_previews(tiff.first_ifd, 0, &mut previews, &mut visited);

    // Largest first. ProRAW puts its full-sensor preview in IFD0, but ordering
    // by pixel count rather than position means a future layout change degrades
    // into "picks the best available" instead of "picks the wrong one".
    previews.sort_by_key(|p| std::cmp::Reverse(u64::from(p.width) * u64::from(p.height)));

    let orientation = scalar(&tiff, &ifd0, TAG_ORIENTATION).unwrap_or(1);
    let mut best_rejected: Option<&Preview> = None;

    for preview in &previews {
        // Tag dimensions are a hint for ranking; the decoder is the authority,
        // and a truncated or malformed strip simply drops to the next
        // candidate rather than failing the whole file.
        let Some(image) = preview.decode(buf) else {
            continue;
        };
        if image.width().max(image.height()) < MIN_PREVIEW_LONG_EDGE {
            best_rejected.get_or_insert(preview);
            continue;
        }
        return Ok(apply_orientation(image, orientation));
    }

    Err(match best_rejected {
        Some(p) => AppError::Image(crate::trf!(
            "该 DNG 只内嵌了 {}x{} 的缩略图，分辨率不足以识别。请改用原始 JPEG 或 TIFF。",
            "This DNG only embeds a {}x{} thumbnail, too low-resolution to recognize. Use the original JPEG or TIFF instead.",
            p.width,
            p.height
        )),
        None => AppError::Image(
            crate::tr!(
                "该 DNG 没有内嵌可读的预览图，无法读取。请改用原始 JPEG 或 TIFF。",
                "This DNG embeds no readable preview and cannot be read. Use the original JPEG or TIFF instead."
            )
            .to_string(),
        ),
    })
}

/// A JPEG-compressed sub-image found somewhere in the IFD tree.
struct Preview {
    width: u32,
    height: u32,
    offset: usize,
    len: usize,
}

impl Preview {
    fn decode(&self, buf: &[u8]) -> Option<DynamicImage> {
        let bytes = buf.get(self.offset..self.offset.checked_add(self.len)?)?;
        ::image::load_from_memory_with_format(bytes, ImageFormat::Jpeg).ok()
    }
}

struct Tiff<'a> {
    buf: &'a [u8],
    little_endian: bool,
    first_ifd: usize,
}

impl<'a> Tiff<'a> {
    fn new(buf: &'a [u8]) -> Option<Self> {
        let little_endian = match buf.get(..2)? {
            b"II" => true,
            b"MM" => false,
            _ => return None,
        };
        let mut tiff = Tiff {
            buf,
            little_endian,
            first_ifd: 0,
        };
        // Magic 42 marks classic TIFF. BigTIFF (43) uses 8-byte offsets
        // throughout; no DNG writer emits it, so reject rather than misparse.
        if tiff.u16_at(2)? != 42 {
            return None;
        }
        tiff.first_ifd = tiff.u32_at(4)? as usize;
        Some(tiff)
    }

    fn u16_at(&self, off: usize) -> Option<u16> {
        let raw: [u8; 2] = self.buf.get(off..off.checked_add(2)?)?.try_into().ok()?;
        Some(if self.little_endian {
            u16::from_le_bytes(raw)
        } else {
            u16::from_be_bytes(raw)
        })
    }

    fn u32_at(&self, off: usize) -> Option<u32> {
        let raw: [u8; 4] = self.buf.get(off..off.checked_add(4)?)?.try_into().ok()?;
        Some(if self.little_endian {
            u32::from_le_bytes(raw)
        } else {
            u32::from_be_bytes(raw)
        })
    }

    /// Reads a NUL-terminated ASCII tag. Values of 4 bytes or fewer are inlined
    /// in the entry like any other type.
    fn ascii(&self, entries: &[Entry], tag: u16) -> Option<String> {
        let entry = entries.iter().find(|e| e.tag == tag)?;
        if entry.kind != 2 {
            return None;
        }
        let count = entry.count as usize;
        let base = if count <= 4 {
            entry.value_offset
        } else {
            self.u32_at(entry.value_offset)? as usize
        };
        let bytes = self.buf.get(base..base.checked_add(count)?)?;
        let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
        Some(String::from_utf8_lossy(&bytes[..end]).into_owned())
    }

    /// Walks the IFD at `offset`, its SubIFDs, and its next-IFD chain,
    /// appending every JPEG-compressed sub-image to `out`.
    ///
    /// `visited` guards against a file whose pointers form a cycle; without it
    /// a crafted DNG would spin here forever.
    fn collect_previews(
        &self,
        offset: usize,
        depth: u8,
        out: &mut Vec<Preview>,
        visited: &mut Vec<usize>,
    ) {
        if depth > MAX_IFD_DEPTH || offset == 0 || visited.contains(&offset) {
            return;
        }
        visited.push(offset);

        let Some(entries) = read_ifd(self, offset) else {
            return;
        };

        if let Some(preview) = self.preview_from(&entries) {
            out.push(preview);
        }

        if let Some(sub) = entries.iter().find(|e| e.tag == TAG_SUB_IFDS) {
            for idx in 0..sub.count.min(MAX_IFD_ENTRIES) {
                if let Some(sub_offset) = self.value(sub, idx) {
                    self.collect_previews(sub_offset as usize, depth + 1, out, visited);
                }
            }
        }

        // Trailing u32 after the entry block points at the next IFD in the
        // chain; DNG uses it for additional full-resolution previews.
        let next_off = offset + 2 + entries.len() * 12;
        if let Some(next) = self.u32_at(next_off) {
            self.collect_previews(next as usize, depth + 1, out, visited);
        }
    }

    fn preview_from(&self, entries: &[Entry]) -> Option<Preview> {
        let compression = scalar(self, entries, TAG_COMPRESSION)?;
        if compression != COMPRESSION_JPEG && compression != COMPRESSION_OLD_JPEG {
            return None;
        }
        // Excludes the mosaic itself. ProRAW stores its lossy raw as photometric
        // 34892 (LinearRaw) under compression 7, so without this check the
        // decoder would try to read the sensor data as a JPEG preview.
        let photometric = scalar(self, entries, TAG_PHOTOMETRIC)?;
        if photometric != PHOTOMETRIC_RGB && photometric != PHOTOMETRIC_YCBCR {
            return None;
        }

        // Previews live under StripOffsets; the legacy JPEGInterchangeFormat
        // pair is used for IFD0 thumbnails. Try both.
        let (offset, len) = self
            .single_strip(entries, TAG_STRIP_OFFSETS, TAG_STRIP_BYTE_COUNTS)
            .or_else(|| self.single_strip(entries, TAG_JPEG_OFFSET, TAG_JPEG_LENGTH))?;

        Some(Preview {
            width: scalar(self, entries, TAG_IMAGE_WIDTH).unwrap_or(0),
            height: scalar(self, entries, TAG_IMAGE_LENGTH).unwrap_or(0),
            offset,
            len,
        })
    }

    /// Reads an offset/length tag pair, rejecting anything split across strips.
    /// Strip boundaries inside a JPEG are restart-marker boundaries rather than
    /// byte-stream ones, so concatenating them does not reliably reproduce the
    /// original stream — and ProRAW writes a single strip anyway.
    fn single_strip(
        &self,
        entries: &[Entry],
        offset_tag: u16,
        length_tag: u16,
    ) -> Option<(usize, usize)> {
        let offset_entry = entries.iter().find(|e| e.tag == offset_tag)?;
        let length_entry = entries.iter().find(|e| e.tag == length_tag)?;
        if offset_entry.count != 1 || length_entry.count != 1 {
            return None;
        }
        let offset = self.value(offset_entry, 0)? as usize;
        let len = self.value(length_entry, 0)? as usize;
        if len == 0 || offset.checked_add(len)? > self.buf.len() {
            return None;
        }
        Some((offset, len))
    }

    /// Reads the `idx`th value of an entry. Values totalling 4 bytes or fewer
    /// are inlined in the entry; anything larger is stored out of line and the
    /// entry holds a pointer.
    fn value(&self, entry: &Entry, idx: u32) -> Option<u32> {
        let size = match entry.kind {
            1 | 2 | 6 | 7 => 1usize, // BYTE, ASCII, SBYTE, UNDEFINED
            3 | 8 => 2,              // SHORT, SSHORT
            4 | 9 | 13 => 4,         // LONG, SLONG, IFD
            _ => return None,
        };
        if idx >= entry.count {
            return None;
        }
        let inline = size as u64 * u64::from(entry.count) <= 4;
        let base = if inline {
            entry.value_offset
        } else {
            self.u32_at(entry.value_offset)? as usize
        };
        let at = base.checked_add(size.checked_mul(idx as usize)?)?;
        match size {
            1 => self.buf.get(at).copied().map(u32::from),
            2 => self.u16_at(at).map(u32::from),
            _ => self.u32_at(at),
        }
    }
}

struct Entry {
    tag: u16,
    kind: u16,
    count: u32,
    /// Offset of the entry's 4-byte value field, not of the value itself.
    value_offset: usize,
}

fn read_ifd(tiff: &Tiff, offset: usize) -> Option<Vec<Entry>> {
    let count = u32::from(tiff.u16_at(offset)?);
    if count == 0 || count > MAX_IFD_ENTRIES {
        return None;
    }
    let mut entries = Vec::with_capacity(count as usize);
    for i in 0..count as usize {
        let at = offset.checked_add(2)?.checked_add(i.checked_mul(12)?)?;
        entries.push(Entry {
            tag: tiff.u16_at(at)?,
            kind: tiff.u16_at(at + 2)?,
            count: tiff.u32_at(at + 4)?,
            value_offset: at + 8,
        });
    }
    Some(entries)
}

fn scalar(tiff: &Tiff, entries: &[Entry], tag: u16) -> Option<u32> {
    tiff.value(entries.iter().find(|e| e.tag == tag)?, 0)
}

/// Applies an EXIF orientation code. Written out rather than using
/// `DynamicImage::apply_orientation` so the mapping is visible next to the
/// tag that produces it.
fn apply_orientation(image: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.rotate90().fliph(),
        6 => image.rotate90(),
        7 => image.rotate270().fliph(),
        8 => image.rotate270(),
        _ => image,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::image::{ImageBuffer, Rgb};

    /// Builds a little-endian TIFF whose IFD0 is a thumbnail and whose SubIFD
    /// is a larger preview — the layout Lightroom and iPhone ProRAW produce.
    /// `make` empty omits the tag entirely, standing in for a writer that
    /// records no camera at all.
    fn synthetic_dng(
        make: &str,
        thumb: (u32, u32),
        full: Option<(u32, u32)>,
        orientation: u32,
    ) -> Vec<u8> {
        let jpeg = |w: u32, h: u32| {
            let img = DynamicImage::ImageRgb8(ImageBuffer::from_fn(w, h, |x, _| {
                Rgb([(x % 256) as u8, 128, 200])
            }));
            let mut bytes = std::io::Cursor::new(Vec::new());
            img.write_to(&mut bytes, ImageFormat::Jpeg).unwrap();
            bytes.into_inner()
        };

        let thumb_jpeg = jpeg(thumb.0, thumb.1);
        let full_jpeg = full.map(|(w, h)| jpeg(w, h));
        // Stored out of line, which is where any real `Make` ends up — the
        // shortest plausible one still exceeds an entry's 4-byte value field.
        let make_bytes: Vec<u8> = make.bytes().chain(std::iter::once(0)).collect();
        assert!(
            make.is_empty() || make_bytes.len() > 4,
            "make must not inline"
        );

        // Header (8) + IFD0 + optional SubIFD + Make string, then the JPEGs.
        let ifd0_count = 6
            + usize::from(!make.is_empty())
            + usize::from(orientation != 1)
            + usize::from(full.is_some());
        let ifd0_off = 8usize;
        let ifd0_len = 2 + ifd0_count * 12 + 4;
        let sub_off = ifd0_off + ifd0_len;
        let sub_len = if full.is_some() { 2 + 6 * 12 + 4 } else { 0 };
        let make_off = sub_off + sub_len;
        let thumb_data_off = make_off + if make.is_empty() { 0 } else { make_bytes.len() };
        let full_data_off = thumb_data_off + thumb_jpeg.len();

        let mut out = Vec::new();
        out.extend_from_slice(b"II");
        out.extend_from_slice(&42u16.to_le_bytes());
        out.extend_from_slice(&(ifd0_off as u32).to_le_bytes());

        let push_ifd = |out: &mut Vec<u8>, entries: Vec<(u16, u16, u32, u32)>| {
            out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
            for (tag, kind, count, value) in entries {
                out.extend_from_slice(&tag.to_le_bytes());
                out.extend_from_slice(&kind.to_le_bytes());
                out.extend_from_slice(&count.to_le_bytes());
                out.extend_from_slice(&value.to_le_bytes());
            }
            out.extend_from_slice(&0u32.to_le_bytes());
        };

        // Kept in ascending tag order, as TIFF requires of a real writer.
        let mut ifd0 = vec![
            (TAG_IMAGE_WIDTH, 4u16, 1u32, thumb.0),
            (TAG_IMAGE_LENGTH, 4, 1, thumb.1),
            (TAG_COMPRESSION, 3, 1, COMPRESSION_JPEG),
            (TAG_PHOTOMETRIC, 3, 1, PHOTOMETRIC_YCBCR),
        ];
        if !make.is_empty() {
            ifd0.push((TAG_MAKE, 2, make_bytes.len() as u32, make_off as u32));
        }
        ifd0.push((TAG_STRIP_OFFSETS, 4, 1, thumb_data_off as u32));
        if orientation != 1 {
            ifd0.push((TAG_ORIENTATION, 3, 1, orientation));
        }
        ifd0.push((TAG_STRIP_BYTE_COUNTS, 4, 1, thumb_jpeg.len() as u32));
        if full.is_some() {
            ifd0.push((TAG_SUB_IFDS, 4, 1, sub_off as u32));
        }
        assert_eq!(ifd0.len(), ifd0_count);
        push_ifd(&mut out, ifd0);

        if let Some((fw, fh)) = full {
            let full_jpeg = full_jpeg.as_ref().unwrap();
            push_ifd(
                &mut out,
                vec![
                    (TAG_IMAGE_WIDTH, 4, 1, fw),
                    (TAG_IMAGE_LENGTH, 4, 1, fh),
                    (TAG_COMPRESSION, 3, 1, COMPRESSION_JPEG),
                    (TAG_PHOTOMETRIC, 3, 1, PHOTOMETRIC_YCBCR),
                    (TAG_STRIP_OFFSETS, 4, 1, full_data_off as u32),
                    (TAG_STRIP_BYTE_COUNTS, 4, 1, full_jpeg.len() as u32),
                ],
            );
        }

        if !make.is_empty() {
            out.extend_from_slice(&make_bytes);
        }
        assert_eq!(out.len(), thumb_data_off);
        out.extend_from_slice(&thumb_jpeg);
        if let Some(full_jpeg) = full_jpeg {
            out.extend_from_slice(&full_jpeg);
        }
        out
    }

    fn apple_dng(thumb: (u32, u32), full: Option<(u32, u32)>, orientation: u32) -> Vec<u8> {
        synthetic_dng("Apple", thumb, full, orientation)
    }

    fn error_message(dng: &[u8]) -> String {
        match decode_preview(dng).unwrap_err() {
            AppError::Image(message) => message,
            other => panic!("expected AppError::Image, got {other:?}"),
        }
    }

    #[test]
    fn picks_the_largest_preview_not_the_thumbnail() {
        let dng = apple_dng((160, 120), Some((2000, 1500)), 1);
        let img = decode_preview(&dng).unwrap();
        assert_eq!(img.width(), 2000);
        assert_eq!(img.height(), 1500);
    }

    #[test]
    fn rejects_files_from_other_writers_by_name() {
        // A Canon DNG may well carry a perfectly good preview, but whether it
        // does is a converter setting rather than a guarantee, so it is refused
        // on provenance instead of on whatever this particular file happens to
        // contain.
        let dng = synthetic_dng("Canon", (160, 120), Some((2000, 1500)), 1);
        let message = error_message(&dng);
        assert!(message.contains("Canon"), "got: {message}");
        assert!(message.contains("ProRAW"), "got: {message}");
    }

    #[test]
    fn rejects_files_with_no_make_tag() {
        let dng = synthetic_dng("", (160, 120), Some((2000, 1500)), 1);
        let message = error_message(&dng);
        assert!(message.contains("未知来源"), "got: {message}");
    }

    #[test]
    fn accepts_make_regardless_of_case() {
        let dng = synthetic_dng("APPLE", (160, 120), Some((2000, 1500)), 1);
        assert!(decode_preview(&dng).is_ok());
    }

    #[test]
    fn rejects_thumbnail_only_files_with_an_actionable_message() {
        let message = error_message(&apple_dng((160, 120), None, 1));
        assert!(message.contains("160x120"), "got: {message}");
    }

    #[test]
    fn applies_exif_orientation() {
        // Orientation 6 is a 90° rotation, so a landscape preview comes back
        // portrait — this is what puts a page shot in portrait upright.
        let dng = apple_dng((160, 120), Some((2000, 1500)), 6);
        let img = decode_preview(&dng).unwrap();
        assert_eq!(img.width(), 1500);
        assert_eq!(img.height(), 2000);
    }

    #[test]
    fn rejects_non_tiff_input() {
        assert!(decode_preview(b"not a dng at all").is_err());
        assert!(decode_preview(&[]).is_err());
    }

    #[test]
    fn survives_a_truncated_file_without_panicking() {
        let dng = apple_dng((160, 120), Some((2000, 1500)), 1);
        for cut in [8, 20, 60, 120, dng.len() / 2] {
            let _ = decode_preview(&dng[..cut.min(dng.len())]);
        }
    }

    #[test]
    fn survives_a_self_referential_ifd() {
        // IFD0's next-IFD pointer aimed back at itself: the visited set has to
        // break the cycle rather than recursing until the stack gives out.
        let mut dng = apple_dng((160, 120), Some((2000, 1500)), 1);
        let ifd0_count = u16::from_le_bytes([dng[8], dng[9]]) as usize;
        let next_ptr = 8 + 2 + ifd0_count * 12;
        dng[next_ptr..next_ptr + 4].copy_from_slice(&8u32.to_le_bytes());
        let img = decode_preview(&dng).unwrap();
        assert_eq!(img.width(), 2000);
    }
}
