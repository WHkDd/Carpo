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
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::pdf_chunk::{self, ChunkConfig, ChunkManifest};

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

/// Long-edge ceiling, in pixels, for the *bitmap the webview decodes*.
///
/// PDF previews are bounded by their 150 DPI render, but raster images are
/// loaded at whatever resolution they were scanned at. A 600 DPI broadsheet
/// scan is ~13000x18000 — 234 megapixels, ~936 MB decoded RGBA — and WKWebView
/// refuses to decode it. The failure mode is indistinguishable from a dead
/// object URL: blank canvas, blocks still drawn on top.
///
/// Set above [`DEFAULT_OCR_MAX_LONG_EDGE_PX`] rather than equal to it: that one
/// answers "how many pixels does the model use", this one answers "how many
/// pixels can the webview decode", and the second number is larger. It is also
/// chosen to sit above the common camera long edge (a 12MP phone photo is 4032)
/// so archival captures pass through untouched instead of paying a full resize
/// pass to lose 0.8% of their height.
///
/// At the ceiling a square source decodes to ~36 MP / 144 MB RGBA, which
/// WKWebView handles; the 234 MP case above is what it refuses. Nothing
/// downstream sees the clamp — the OCR path re-reads the original file from
/// disk — so the only cost is preview sharpness on genuinely enormous scans.
pub const PREVIEW_MAX_LONG_EDGE_PX: u32 = 6000;

/// Downscales `image` so neither edge exceeds [`PREVIEW_MAX_LONG_EDGE_PX`],
/// preserving aspect ratio. Returns the image untouched when it already fits,
/// which is the common case (PDF previews, ordinary scans).
///
/// Callers must keep reporting the *pre-clamp* dimensions to the frontend:
/// block rects for images are stored in native pixel coordinates and
/// `grouped::page_scale` assumes a 1.0 scale for `FileKind::Image`. The canvas
/// draws the clamped bitmap stretched back to those dimensions.
pub fn clamp_preview_dimensions(image: DynamicImage) -> DynamicImage {
    let (w, h) = image.dimensions();
    if w <= PREVIEW_MAX_LONG_EDGE_PX && h <= PREVIEW_MAX_LONG_EDGE_PX {
        return image;
    }
    // `resize` fits the image inside the box while preserving aspect ratio, so
    // passing the cap for both edges clamps the longer one and lets the
    // shorter one fall out proportionally. Triangle over Lanczos3: at 200+
    // megapixels the sharper filter costs seconds of UI latency to win detail
    // that a downscaled preview cannot show anyway.
    image.resize(
        PREVIEW_MAX_LONG_EDGE_PX,
        PREVIEW_MAX_LONG_EDGE_PX,
        image::imageops::FilterType::Triangle,
    )
}

// Separate from the main `tests` module below, which is gated on the platforms
// that ship PDFium — none of this touches it.
#[cfg(test)]
mod preview_clamp_tests {
    use super::*;

    fn blank(w: u32, h: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(image::RgbImage::new(w, h))
    }

    #[test]
    fn images_within_the_cap_are_returned_untouched() {
        // 12MP phone capture — the shape most archival photography arrives in,
        // and the reason the cap sits above 4032 rather than at 4000.
        let out = clamp_preview_dimensions(blank(3024, 4032));
        assert_eq!(out.dimensions(), (3024, 4032));
    }

    #[test]
    fn oversized_images_clamp_the_long_edge_and_keep_aspect() {
        // A 600 DPI broadsheet scan: the case that made WKWebView give up.
        let out = clamp_preview_dimensions(blank(13000, 18000));
        assert_eq!(out.height(), PREVIEW_MAX_LONG_EDGE_PX);
        let ratio = out.width() as f32 / out.height() as f32;
        assert!((ratio - 13000.0 / 18000.0).abs() < 0.01, "got {ratio}");
    }

    #[test]
    fn clamps_on_width_for_landscape_sources() {
        let out = clamp_preview_dimensions(blank(9000, 3000));
        assert_eq!(out.width(), PREVIEW_MAX_LONG_EDGE_PX);
        assert!(out.height() < PREVIEW_MAX_LONG_EDGE_PX);
    }
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

/// Long-edge ceiling, in pixels, for whole-page OCR renders.
///
/// The whole-file runner ships the *entire* page to a vision model, and every
/// current provider downsamples its input well below this (Claude tops out
/// around 1568px on the long edge, GPT-4o tiles at 768/2000, Gemini around
/// 3072). Rendering a broadsheet scan at a naive 300 DPI produces a
/// 4605x6495 bitmap — ~114 MB decoded, times the page LRU, times a full-size
/// copy per in-flight encode — and then the model throws most of it away. The
/// pixels above this line cost memory and upload time and buy nothing.
///
/// The unit that matters here is *pixels the model receives*, not DPI: 4000
/// on the long edge is still above every provider's own input resolution, so
/// the clamp is lossless in practice even where it engages. Concretely, at
/// 300 DPI: A4 (3508px) passes through untouched; A3 (4962px) clamps to 4000,
/// i.e. an effective ~242 DPI; a broadsheet (6496px) clamps to 4000, i.e.
/// ~185 DPI and a 2.6x cut in decoded bytes.
///
/// Deliberately *not* applied to the grouped path — that one crops small
/// blocks out of the page and sends the crops, so page-level downscaling
/// there is a real resolution loss rather than a free one.
///
/// Override with `CARPO_OCR_MAX_LONG_EDGE`; `0` disables the clamp entirely.
pub const DEFAULT_OCR_MAX_LONG_EDGE_PX: u32 = 4000;

/// Reads the effective whole-page OCR long-edge cap. Returns `None` when the
/// clamp is disabled (`CARPO_OCR_MAX_LONG_EDGE=0`).
pub fn ocr_max_long_edge() -> Option<u32> {
    let configured = env::var("CARPO_OCR_MAX_LONG_EDGE")
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .unwrap_or(DEFAULT_OCR_MAX_LONG_EDGE_PX);
    (configured > 0).then_some(configured)
}

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
    render_page_image_capped_with(pdfium, path, page, dpi, None)
}

/// As [`render_page_image_with`], but clamps the render scale so the longer
/// edge never exceeds `max_long_edge` pixels. The clamp is applied to the
/// *render config*, not by downscaling afterwards — PDFium never allocates
/// the oversized bitmap in the first place, which is the whole point.
pub fn render_page_image_capped_with(
    pdfium: &Pdfium,
    path: &Path,
    page: u32,
    dpi: u32,
    max_long_edge: Option<u32>,
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

    let scale = render_scale_for(page.width().value, page.height().value, dpi, max_long_edge);
    let bitmap = page
        .render_with_config(&PdfRenderConfig::new().scale_page_by_factor(scale))
        .map_err(map_pdfium_error)?;
    Ok(bitmap.as_image())
}

/// Scale factor (PDF points -> pixels) for `dpi`, reduced just enough to keep
/// the longer rendered edge within `max_long_edge`. Pages that already fit
/// keep the exact `dpi/72` factor, so the common case is bit-for-bit
/// unchanged.
fn render_scale_for(width_pt: f32, height_pt: f32, dpi: u32, max_long_edge: Option<u32>) -> f32 {
    let scale = dpi as f32 / 72.0;
    let Some(cap) = max_long_edge else {
        return scale;
    };
    let long_edge_pt = width_pt.max(height_pt);
    if long_edge_pt <= 0.0 {
        return scale;
    }
    let capped = cap as f32 / long_edge_pt;
    if capped < scale {
        capped
    } else {
        scale
    }
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

    if let Some(path) = env::var_os("CARPO_PDFIUM_LIBRARY_PATH") {
        candidates.push(PathBuf::from(path));
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
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
            } else if cfg!(target_os = "linux") {
                candidates.push(exe_dir.join("libpdfium.so"));
            }
        }
    }

    candidates.push(dev_pdfium_library_path()?);
    if let Some(path) = shared_pdfium_library_path() {
        candidates.push(path);
    }
    Ok(candidates)
}

fn dev_pdfium_library_path() -> AppResult<PathBuf> {
    let arch = match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => "macos-arm64",
        ("windows", "x86_64") => "windows-x64",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        (os, arch) => {
            return Err(AppError::Pdf(format!(
                "unsupported pdfium dev target: {os}/{arch} \
                 (supported: macos/aarch64, windows/x86_64, linux/x86_64, linux/aarch64)"
            )))
        }
    };

    let filename = if cfg!(target_os = "windows") {
        "pdfium.dll"
    } else if cfg!(target_os = "linux") {
        "libpdfium.so"
    } else {
        "libpdfium.dylib"
    };

    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("pdfium")
        .join(arch)
        .join(filename))
}

fn shared_pdfium_library_path() -> Option<PathBuf> {
    let arch = match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => "macos-arm64",
        ("windows", "x86_64") => "windows-x64",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        _ => return None,
    };

    let filename = if cfg!(target_os = "windows") {
        "pdfium.dll"
    } else if cfg!(target_os = "linux") {
        "libpdfium.so"
    } else {
        "libpdfium.dylib"
    };

    let cache_root = env::var_os("CARPO_PDFIUM_CACHE_DIR")
        .map(PathBuf::from)
        .or_else(default_pdfium_cache_root)?;
    let version = include_str!("../pdfium/VERSION").trim().replace('/', "_");

    Some(cache_root.join(version).join(arch).join(filename))
}

fn default_pdfium_cache_root() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        env::var_os("HOME").map(PathBuf::from).map(|home| {
            home.join("Library")
                .join("Caches")
                .join("carpo")
                .join("pdfium")
        })
    } else if cfg!(target_os = "windows") {
        env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|local| local.join("carpo").join("pdfium"))
    } else if cfg!(target_os = "linux") {
        env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
            .map(|cache| cache.join("carpo").join("pdfium"))
    } else {
        None
    }
}

fn map_pdfium_error(err: PdfiumError) -> AppError {
    AppError::Pdf(err.to_string())
}

/// Synchronous chunking helper invoked from the PdfWorker thread.
/// Creates a fresh `TempDir`, calls into [`pdf_chunk::build_chunks`],
/// and returns both so the caller can hold the dir alive for the
/// lifetime of the OCR job.
fn build_chunks_blocking(
    pdfium: &Pdfium,
    source_path: &Path,
    requested_pages: &[u32],
    source_size_bytes: u64,
    source_page_count: u32,
    config: &ChunkConfig,
) -> AppResult<ChunkBuildOutput> {
    let temp_dir = tempfile::Builder::new()
        .prefix("carpo-paddle-chunks-")
        .tempdir()
        .map_err(|e| AppError::Internal(format!("create temp chunk dir: {e}")))?;
    let manifests = pdf_chunk::build_chunks(
        pdfium,
        source_path,
        requested_pages,
        temp_dir.path(),
        source_size_bytes,
        source_page_count,
        config,
    )?;
    Ok(ChunkBuildOutput {
        temp_dir,
        manifests,
    })
}

// --- PdfWorker --------------------------------------------------------------

/// Tasks the PdfWorker thread can perform. Each variant carries a oneshot
/// channel back to the caller so any error path reaches the original
/// async caller without unwinding through the worker thread. `cancel`
/// (where present) lets the worker thread skip work that's already been
/// cancelled while it was sitting in the mpsc queue — PDFium itself has
/// no abort API, so once a render starts it runs to completion, but
/// queued-but-not-started tasks are checked at pull time.
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
        /// Long-edge pixel ceiling; `None` renders at exactly `dpi`.
        max_long_edge: Option<u32>,
        resp: oneshot::Sender<AppResult<DynamicImage>>,
        cancel: Option<CancellationToken>,
    },
    BuildChunks {
        path: PathBuf,
        requested_pages: Vec<u32>,
        source_size_bytes: u64,
        source_page_count: u32,
        config: ChunkConfig,
        resp: oneshot::Sender<AppResult<ChunkBuildOutput>>,
    },
}

/// Result of a [`PdfWorker::build_chunks`] call. Holds the owned
/// `TempDir` so the chunk files survive past the call; dropping the
/// returned value cleans them all up.
#[derive(Debug)]
pub struct ChunkBuildOutput {
    pub temp_dir: tempfile::TempDir,
    pub manifests: Vec<ChunkManifest>,
}

impl ChunkBuildOutput {
    pub fn temp_dir_path(&self) -> &Path {
        self.temp_dir.path()
    }
}

fn cancel_fired(cancel: &Option<CancellationToken>) -> bool {
    cancel.as_ref().is_some_and(|t| t.is_cancelled())
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
            .name("carpo-pdfium".into())
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
                            max_long_edge,
                            resp,
                            cancel,
                        } => {
                            // Skip-if-cancelled: a task may have been sitting
                            // in the queue while its caller was cancelled at
                            // the outer `tokio::select!`. Draining it without
                            // running the render reclaims worker time for the
                            // next job.
                            if cancel_fired(&cancel) {
                                let _ = resp.send(Err(AppError::Cancelled(
                                    "pdf render task cancelled before start".into(),
                                )));
                                continue;
                            }
                            let _ = resp.send(render_page_image_capped_with(
                                &pdfium,
                                &path,
                                page,
                                dpi,
                                max_long_edge,
                            ));
                        }
                        PdfTask::BuildChunks {
                            path,
                            requested_pages,
                            source_size_bytes,
                            source_page_count,
                            config,
                            resp,
                        } => {
                            let _ = resp.send(build_chunks_blocking(
                                &pdfium,
                                &path,
                                &requested_pages,
                                source_size_bytes,
                                source_page_count,
                                &config,
                            ));
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

    /// Builds chunked PDFs for Paddle's document-level OCR path. The
    /// caller hands us the *sorted, deduplicated* page list — pdfium
    /// runs inside the worker thread because `Pdfium` isn't `Send`. The
    /// returned `ChunkBuildOutput` owns a `TempDir`; chunk files live
    /// inside it and are removed when the caller drops the value.
    pub async fn build_chunks(
        &self,
        path: PathBuf,
        requested_pages: Vec<u32>,
        source_size_bytes: u64,
        source_page_count: u32,
        config: ChunkConfig,
    ) -> AppResult<ChunkBuildOutput> {
        let (rtx, rrx) = oneshot::channel();
        self.dispatch(
            PdfTask::BuildChunks {
                path,
                requested_pages,
                source_size_bytes,
                source_page_count,
                config,
                resp: rtx,
            },
            rrx,
        )
        .await
    }

    /// Renders a page as a `DynamicImage`, with an optional cancellation
    /// token. If the token fires while the task is sitting in the worker
    /// queue, the task is skipped at pull time and returns
    /// `AppError::Cancelled`. PDFium has no abort API so an already
    /// in-flight render still runs to completion — pair this with a
    /// caller-side `tokio::select!` against the same token if you also
    /// want the *caller* to stop waiting (the orphaned render then
    /// silently sends its result into a closed oneshot). Pass `None` for
    /// preview-style fire-and-forget callers.
    pub async fn render_image_cancellable(
        &self,
        path: PathBuf,
        page: u32,
        dpi: u32,
        max_long_edge: Option<u32>,
        cancel: Option<CancellationToken>,
    ) -> AppResult<DynamicImage> {
        let (rtx, rrx) = oneshot::channel();
        self.dispatch(
            PdfTask::RenderImage {
                path,
                page,
                dpi,
                max_long_edge,
                resp: rtx,
                cancel,
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
            "/../src-tauri/tests/fixtures/sample.pdf"
        ))
    }

    // A4 and A3 in PDF points (72/inch).
    const A4_PT: (f32, f32) = (595.0, 842.0);
    const A3_PT: (f32, f32) = (842.0, 1191.0);
    // Broadsheet newspaper, ~390x550mm.
    const BROADSHEET_PT: (f32, f32) = (1105.0, 1559.0);

    #[test]
    fn render_scale_is_untouched_without_a_cap() {
        let (w, h) = BROADSHEET_PT;
        assert!((render_scale_for(w, h, 300, None) - 300.0 / 72.0).abs() < f32::EPSILON);
    }

    #[test]
    fn render_scale_leaves_pages_that_already_fit_exact() {
        // A4 at 300 dpi is 3508px on the long edge — under the cap, so the
        // factor must come through as exactly dpi/72, not merely close.
        let (w, h) = A4_PT;
        let scale = render_scale_for(w, h, 300, Some(DEFAULT_OCR_MAX_LONG_EDGE_PX));
        assert!(
            (scale - 300.0 / 72.0).abs() < f32::EPSILON,
            "A4 should pass through unclamped, got {scale}"
        );
    }

    #[test]
    fn render_scale_clamps_oversized_pages_to_the_long_edge() {
        // A3 (4962px at 300 dpi) and broadsheet (6496px) both exceed the cap.
        let cap = DEFAULT_OCR_MAX_LONG_EDGE_PX;
        for (w, h) in [A3_PT, BROADSHEET_PT] {
            let scale = render_scale_for(w, h, 300, Some(cap));
            assert!(scale < 300.0 / 72.0, "{w}x{h}pt at 300 dpi should clamp");

            let long_edge_px = w.max(h) * scale;
            assert!(
                (long_edge_px - cap as f32).abs() < 1.0,
                "clamped long edge should land on the cap, got {long_edge_px}"
            );
        }
    }

    #[test]
    fn render_scale_never_upscales_a_small_page() {
        // A cap is a ceiling, not a target: a page already under it keeps its
        // requested dpi rather than being stretched up to the cap.
        let (w, h) = A4_PT;
        let scale = render_scale_for(w, h, 150, Some(DEFAULT_OCR_MAX_LONG_EDGE_PX));
        assert!((scale - 150.0 / 72.0).abs() < f32::EPSILON, "got {scale}");
    }

    #[test]
    fn render_scale_tolerates_a_degenerate_page_size() {
        assert!((render_scale_for(0.0, 0.0, 300, Some(4000)) - 300.0 / 72.0).abs() < f32::EPSILON);
    }

    #[test]
    fn ocr_max_long_edge_defaults_and_can_be_disabled() {
        // Not asserting on the env-var branches — the process-wide env is
        // shared across parallel tests — just that the default is live.
        assert_eq!(DEFAULT_OCR_MAX_LONG_EDGE_PX, 4000);
        assert!(DEFAULT_OCR_MAX_LONG_EDGE_PX > 0);
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

    #[tokio::test]
    async fn worker_skips_already_cancelled_render_image_task() {
        // The worker drains pre-cancelled tasks at pull time without
        // calling PDFium. With the token already fired, we should get
        // back AppError::Cancelled without ever touching the renderer.
        let worker = PdfWorker::spawn().unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let err = worker
            .render_image_cancellable(sample_pdf().to_path_buf(), 1, 150, None, Some(cancel))
            .await
            .unwrap_err();
        match err {
            AppError::Cancelled(msg) => {
                assert!(msg.contains("cancelled before start"), "{msg}");
            }
            other => panic!("expected Cancelled, got {other:?}"),
        }
    }
}
