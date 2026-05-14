//! PDFium integration.
//!
//! `Pdfium` is not `Send` even with the `thread_safe` feature, so we don't try
//! to share it across async tasks. Instead, [`PdfWorker`] owns the `Pdfium`
//! handle in a dedicated OS thread and exposes async methods that send tasks
//! to it via a tokio mpsc channel. Callers (`#[tauri::command]` functions and
//! the OCR job runners) get fully async-friendly behaviour without blocking
//! tokio worker threads on PDF rendering.

use std::{
    env,
    io::Cursor,
    path::{Path, PathBuf},
};

use ::image::{DynamicImage, GenericImageView};
use pdfium_render::prelude::{PdfDocumentMetadataTagType, PdfRenderConfig, Pdfium, PdfiumError};
use tokio::sync::{mpsc, oneshot};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct PdfInfoData {
    pub page_count: u32,
    pub title: Option<String>,
}

/// JPEG quality used for preview encodes. 85 is a sweet spot for newspaper
/// scans: text edges stay crisp and file size drops ~6× vs PNG, so the IPC
/// payload and decode time both shrink. Tune carefully — too low and the
/// preview canvas starts to look "compressed".
pub const PREVIEW_JPEG_QUALITY: u8 = 85;

/// Preview-grade page bitmap. The `bytes` payload is JPEG-encoded (see
/// [`PREVIEW_JPEG_QUALITY`]); the frontend wraps it in a Blob with the
/// matching MIME and hands the object URL to Konva. `bytes` was named
/// `png_bytes` historically — the format changed but the wire shape is
/// unchanged (width/height prefix + image bytes).
#[derive(Debug)]
pub struct RenderedPage {
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
}

pub fn init_pdfium() -> AppResult<Pdfium> {
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

pub fn render_page_with(
    pdfium: &Pdfium,
    path: &Path,
    page: u32,
    dpi: u32,
) -> AppResult<RenderedPage> {
    let image = render_page_image_with(pdfium, path, page, dpi)?;
    let (width, height) = image.dimensions();
    let bytes = encode_preview_jpeg(image)?;
    Ok(RenderedPage {
        width,
        height,
        bytes,
    })
}

/// Encodes a bitmap as a preview-grade JPEG. JPEG can't carry an alpha
/// channel, so RGBA inputs are flattened to RGB first. For OCR-grade
/// renders use the raw `DynamicImage` returned by `render_page_image_with`
/// — this helper is for the canvas preview only.
pub fn encode_preview_jpeg(image: DynamicImage) -> AppResult<Vec<u8>> {
    use image::codecs::jpeg::JpegEncoder;

    let rgb = image.into_rgb8();
    let (w, h) = rgb.dimensions();
    let mut buf = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, PREVIEW_JPEG_QUALITY);
    encoder
        .encode(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8)
        .map_err(|err| AppError::Image(format!("jpeg encode failed: {err}")))?;
    Ok(buf.into_inner())
}

/// Hard ceiling on render DPI. The frontend currently caps requests at 300
/// (OCR profile "standard"); anything past 600 is almost certainly a bug or a
/// hostile payload. At 600 DPI an A3 page is already ~700 MB decoded — past
/// this point we stop trusting the caller and reject up front instead of
/// letting PDFium try to allocate.
pub const MAX_DPI: u32 = 600;

/// Renders a page into an in-memory `DynamicImage` without the PNG
/// encode/decode round-trip. Used by the OCR job runners — they crop and
/// re-encode inside their own concurrency loop, so handing them a decoded
/// bitmap saves one full PNG round-trip per page.
pub fn render_page_image_with(
    pdfium: &Pdfium,
    path: &Path,
    page: u32,
    dpi: u32,
) -> AppResult<DynamicImage> {
    if dpi == 0 {
        return Err(AppError::Pdf("dpi must be greater than 0".to_string()));
    }
    if dpi > MAX_DPI {
        return Err(AppError::Pdf(format!(
            "dpi {dpi} exceeds maximum {MAX_DPI}"
        )));
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
    Ok(bitmap.as_image())
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
                candidates.push(exe_dir.join("resources").join("pdfium.dll"));
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

// --- PdfWorker --------------------------------------------------------------

/// Tasks the PdfWorker thread can perform. Each variant carries a oneshot
/// channel back to the caller so any error path reaches the original
/// async caller without unwinding through the worker thread.
enum PdfTask {
    Info {
        path: PathBuf,
        resp: oneshot::Sender<AppResult<PdfInfoData>>,
    },
    RenderPng {
        path: PathBuf,
        page: u32,
        dpi: u32,
        resp: oneshot::Sender<AppResult<RenderedPage>>,
    },
    RenderImage {
        path: PathBuf,
        page: u32,
        dpi: u32,
        resp: oneshot::Sender<AppResult<DynamicImage>>,
    },
}

/// Owns the `Pdfium` handle on a dedicated OS thread. All public methods are
/// async and dispatch into that thread via a tokio mpsc channel.
///
/// Why a dedicated thread, not `tokio::task::spawn_blocking`: `Pdfium` is not
/// `Send`, so it cannot be moved between threads. Pinning it to one thread
/// avoids the `unsafe impl Send` pattern entirely while still letting every
/// async caller stay non-blocking.
pub struct PdfWorker {
    tx: mpsc::Sender<PdfTask>,
}

/// Bounded mpsc depth for the PDFium worker. This is the *backpressure
/// point*: callers calling `tx.send(task).await` will suspend once the
/// queue is full instead of growing it unbounded. 32 is large enough to
/// absorb a burst of preview renders during fast page-flips while still
/// shedding load if the renderer falls behind permanently.
const PDF_WORKER_QUEUE_DEPTH: usize = 32;

impl PdfWorker {
    pub fn spawn() -> AppResult<Self> {
        let (tx, mut rx) = mpsc::channel::<PdfTask>(PDF_WORKER_QUEUE_DEPTH);
        // `Pdfium` is not `Send`, so we cannot move it between threads. Init
        // it inside the worker thread and signal the outcome back over a
        // oneshot channel so PdfWorker::spawn surfaces init failures.
        let (init_tx, init_rx) = std::sync::mpsc::channel::<AppResult<()>>();
        std::thread::Builder::new()
            .name("xcvt-pdfium".into())
            .spawn(move || {
                let pdfium = match init_pdfium() {
                    Ok(p) => {
                        let _ = init_tx.send(Ok(()));
                        p
                    }
                    Err(e) => {
                        let _ = init_tx.send(Err(e));
                        return;
                    }
                };
                while let Some(task) = rx.blocking_recv() {
                    match task {
                        PdfTask::Info { path, resp } => {
                            let _ = resp.send(pdf_info_with(&pdfium, &path));
                        }
                        PdfTask::RenderPng {
                            path,
                            page,
                            dpi,
                            resp,
                        } => {
                            let _ = resp.send(render_page_with(&pdfium, &path, page, dpi));
                        }
                        PdfTask::RenderImage {
                            path,
                            page,
                            dpi,
                            resp,
                        } => {
                            let _ = resp.send(render_page_image_with(&pdfium, &path, page, dpi));
                        }
                    }
                }
            })
            .map_err(|e| AppError::Internal(format!("spawn pdf worker thread: {e}")))?;

        init_rx
            .recv()
            .map_err(|_| AppError::Internal("pdf worker init channel closed".into()))??;
        Ok(Self { tx })
    }

    async fn dispatch<T>(
        &self,
        task: PdfTask,
        rrx: oneshot::Receiver<AppResult<T>>,
    ) -> AppResult<T> {
        self.tx
            .send(task)
            .await
            .map_err(|_| AppError::Internal("pdf worker channel closed".into()))?;
        rrx.await
            .map_err(|_| AppError::Internal("pdf worker dropped response".into()))?
    }

    pub async fn info(&self, path: PathBuf) -> AppResult<PdfInfoData> {
        let (rtx, rrx) = oneshot::channel();
        self.dispatch(PdfTask::Info { path, resp: rtx }, rrx).await
    }

    pub async fn render_png(&self, path: PathBuf, page: u32, dpi: u32) -> AppResult<RenderedPage> {
        let (rtx, rrx) = oneshot::channel();
        self.dispatch(
            PdfTask::RenderPng {
                path,
                page,
                dpi,
                resp: rtx,
            },
            rrx,
        )
        .await
    }

    pub async fn render_image(
        &self,
        path: PathBuf,
        page: u32,
        dpi: u32,
    ) -> AppResult<DynamicImage> {
        let (rtx, rrx) = oneshot::channel();
        self.dispatch(
            PdfTask::RenderImage {
                path,
                page,
                dpi,
                resp: rtx,
            },
            rrx,
        )
        .await
    }
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

        let info = pdf_info_with(&pdfium, sample_pdf()).unwrap();
        assert_eq!(info.page_count, 2);

        let rendered = render_page_with(&pdfium, sample_pdf(), 1, 150).unwrap();
        assert!(rendered.width > 0);
        assert!(rendered.height > 0);
        // JPEG SOI marker.
        assert!(rendered.bytes.starts_with(b"\xff\xd8\xff"));

        let image = render_page_image_with(&pdfium, sample_pdf(), 1, 150).unwrap();
        assert!(image.width() > 0 && image.height() > 0);
    }

    #[test]
    fn rejects_dpi_above_max() {
        let pdfium = init_pdfium().unwrap();
        let err = render_page_image_with(&pdfium, sample_pdf(), 1, MAX_DPI + 1).unwrap_err();
        match err {
            AppError::Pdf(msg) => assert!(msg.contains("exceeds maximum")),
            other => panic!("expected Pdf, got {other:?}"),
        }
    }
}
