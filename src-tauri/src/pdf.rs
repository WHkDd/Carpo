use std::{
    env,
    io::Cursor,
    path::{Path, PathBuf},
};

use ::image::{GenericImageView, ImageFormat};
use pdfium_render::prelude::{PdfDocumentMetadataTagType, PdfRenderConfig, Pdfium, PdfiumError};

use crate::error::{AppError, AppResult};

#[derive(Debug)]
pub struct PdfInfoData {
    pub page_count: u32,
    pub title: Option<String>,
}

#[derive(Debug)]
pub struct RenderedPage {
    pub width: u32,
    pub height: u32,
    pub png_bytes: Vec<u8>,
}

pub fn init_pdfium() -> AppResult<Pdfium> {
    // QUESTION(m2): bblanchon latest is chromium/7825 as of 2026-05-08,
    // but pdfium-render 0.8.37 only exposes non-future bindings through 7543.
    let candidates = pdfium_library_candidates()?;
    let mut errors = Vec::new();

    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }

        match Pdfium::bind_to_library(&candidate) {
            Ok(bindings) => {
                log::info!("loaded pdfium from {}", candidate.display());
                return Ok(Pdfium::new(bindings));
            }
            Err(err) => errors.push(format!("{}: {err}", candidate.display())),
        }
    }

    Err(AppError::Pdf(format!(
        "libpdfium not found or failed to load. Run `pnpm prepare:pdfium`. Tried: {}",
        if errors.is_empty() {
            "no existing candidate paths".to_string()
        } else {
            errors.join("; ")
        }
    )))
}

#[allow(dead_code)]
pub fn page_count(path: &Path) -> AppResult<u32> {
    let pdfium = init_pdfium()?;
    page_count_with(&pdfium, path)
}

pub fn pdf_info_with(pdfium: &Pdfium, path: &Path) -> AppResult<PdfInfoData> {
    let document = load_document(pdfium, path)?;
    let title = document
        .metadata()
        .get(PdfDocumentMetadataTagType::Title)
        .map(|tag| tag.value().trim().to_string())
        .filter(|title| !title.is_empty());

    Ok(PdfInfoData {
        page_count: document.pages().len() as u32,
        title,
    })
}

#[allow(dead_code)]
pub fn page_count_with(pdfium: &Pdfium, path: &Path) -> AppResult<u32> {
    Ok(pdf_info_with(pdfium, path)?.page_count)
}

#[allow(dead_code)]
pub fn render_page(path: &Path, page: u32, dpi: u32) -> AppResult<RenderedPage> {
    let pdfium = init_pdfium()?;
    render_page_with(&pdfium, path, page, dpi)
}

pub fn render_page_with(
    pdfium: &Pdfium,
    path: &Path,
    page: u32,
    dpi: u32,
) -> AppResult<RenderedPage> {
    if dpi == 0 {
        return Err(AppError::Pdf("dpi must be greater than 0".to_string()));
    }

    let document = load_document(pdfium, path)?;
    let page_count = document.pages().len() as u32;
    if page == 0 || page > page_count {
        return Err(AppError::Pdf(format!(
            "page {page} out of range 1..={page_count}"
        )));
    }

    let page = document
        .pages()
        .get((page - 1) as u16)
        .map_err(map_pdfium_error)?;
    let bitmap = page
        .render_with_config(&PdfRenderConfig::new().scale_page_by_factor(dpi as f32 / 72.0))
        .map_err(map_pdfium_error)?;
    let image = bitmap.as_image();
    let (width, height) = image.dimensions();

    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|err| AppError::Image(format!("png encode failed: {err}")))?;

    Ok(RenderedPage {
        width,
        height,
        png_bytes: png.into_inner(),
    })
}

fn load_document<'a>(
    pdfium: &'a Pdfium,
    path: &Path,
) -> AppResult<pdfium_render::prelude::PdfDocument<'a>> {
    if !path.exists() {
        return Err(AppError::FileNotFound(path.display().to_string()));
    }

    if !path.is_file() {
        return Err(AppError::Pdf(format!(
            "path is not a file: {}",
            path.display()
        )));
    }

    pdfium
        .load_pdf_from_file(path, None)
        .map_err(map_pdfium_error)
}

fn pdfium_library_candidates() -> AppResult<Vec<PathBuf>> {
    let mut candidates = Vec::new();

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            if cfg!(target_os = "macos") {
                candidates.push(exe_dir.join("Frameworks").join("libpdfium.dylib"));
                if let Some(contents_dir) = exe_dir.parent() {
                    candidates.push(contents_dir.join("Frameworks").join("libpdfium.dylib"));
                }
                candidates.push(exe_dir.join("libpdfium.dylib"));
            } else if cfg!(target_os = "windows") {
                candidates.push(exe_dir.join("pdfium.dll"));
            }
        }
    }

    candidates.extend([dev_pdfium_library_path()?]);
    Ok(candidates)
}

fn dev_pdfium_library_path() -> AppResult<PathBuf> {
    let arch = match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => "macos-arm64",
        ("macos", "x86_64") => "macos-x64",
        ("windows", "x86_64") => "windows-x64",
        (os, arch) => {
            return Err(AppError::Pdf(format!(
                "unsupported pdfium dev target: {os}/{arch}"
            )))
        }
    };

    let filename = if cfg!(target_os = "windows") {
        "pdfium.dll"
    } else {
        "libpdfium.dylib"
    };

    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("pdfium")
        .join(arch)
        .join(filename))
}

fn map_pdfium_error(err: PdfiumError) -> AppError {
    AppError::Pdf(err.to_string())
}

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod tests {
    use super::*;

    fn sample_pdf() -> &'static Path {
        Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/sample.pdf"
        ))
    }

    #[test]
    fn reads_fixture_page_count_and_renders_first_page() {
        let pdfium = init_pdfium().unwrap();

        assert_eq!(page_count_with(&pdfium, sample_pdf()).unwrap(), 2);

        let rendered = render_page_with(&pdfium, sample_pdf(), 1, 150).unwrap();

        assert!(rendered.width > 0);
        assert!(rendered.height > 0);
        assert!(rendered.png_bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}
