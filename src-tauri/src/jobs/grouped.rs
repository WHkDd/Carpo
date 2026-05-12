//! Grouped OCR job runner.
//!
//! Drives the user-marked articles → ordered block refs → cropped page bitmap
//! → `ocr::recognize_with_retry` pipeline. Runs blocks concurrently (bounded
//! by `OCR_CONCURRENCY`) and emits fine-grained progress events: one after
//! the synchronous prerender, one when each block starts, and one when each
//! block finishes. Cancels mid-job by checking the shared `CancellationToken`
//! both at task entry and inside the OCR call via `tokio::select!`.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures::stream::{self, StreamExt};
use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::config::{self, NonSecretSettings, Provider};
use crate::error::{AppError, AppResult};
use crate::events;
use crate::ocr::{self, OcrRequest};
use crate::pdf;
use crate::secrets::{self, SecretKey};
use crate::state::AppState;

/// Max in-flight OCR calls. PaddleOCR's async jobs queue tolerates a few
/// parallel submissions cleanly; 3 keeps us well under documented rate caps
/// while shortening wall-clock proportionally on multi-block runs.
const OCR_CONCURRENCY: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Image,
    Pdf,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BlockRef {
    pub page: u32,
    pub block_id: String,
    pub rect: Rect,
    pub order: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ArticleOcrPlan {
    pub id: String,
    pub title: String,
    pub num: u32,
    pub blocks: Vec<BlockRef>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GroupedOcrRequest {
    // Echoed into the eventual done payload at T5.7 for document assembly,
    // but the worker itself never reads them. Silenced individually so the
    // rest of the struct still benefits from dead-code analysis.
    #[allow(dead_code)]
    pub file_id: String,
    pub path: String,
    pub kind: FileKind,
    /// DPI the frontend was rendering at when the user drew these blocks.
    /// Ignored for `FileKind::Image` (image files have a single native
    /// resolution; block rects are already in native pixel coords).
    pub preview_dpi: u32,
    /// DPI at which the backend re-renders the page before cropping. Higher
    /// is better for OCR quality at the cost of larger payloads.
    pub ocr_dpi: u32,
    pub articles: Vec<ArticleOcrPlan>,
    #[serde(default)]
    #[allow(dead_code)]
    pub newspaper_name: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub newspaper_date: String,
}

#[derive(Debug, Clone, Serialize)]
struct ProgressEvent {
    job_id: String,
    done: u32,
    total: u32,
    label: String,
    current_block: u32,
    article_total: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArticleResultPayload {
    pub article_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArticleErrorPayload {
    pub article_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
struct DoneEvent {
    job_id: String,
    results: Vec<ArticleResultPayload>,
    errors: Vec<ArticleErrorPayload>,
    cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
struct ErrorEvent {
    job_id: String,
    error: String,
}

/// Spawns the worker task. The caller has already registered the job in the
/// `JobRegistry` and holds the matching id + token. When the task exits it
/// removes itself from the registry so cancel commands stop seeing a phantom.
pub fn spawn(app: AppHandle, req: GroupedOcrRequest, job_id: Uuid, token: CancellationToken) {
    tokio::spawn(async move {
        let outcome = run(&app, req, job_id, token).await;
        if let Some(state) = app.try_state::<AppState>() {
            state.jobs.remove(job_id);
        }
        if let Err(e) = outcome {
            log::error!("grouped ocr job {job_id} crashed: {e}");
            let _ = app.emit(
                events::JOB_ERROR,
                ErrorEvent {
                    job_id: job_id.to_string(),
                    error: e.to_string(),
                },
            );
        }
    });
}

async fn run(
    app: &AppHandle,
    req: GroupedOcrRequest,
    job_id: Uuid,
    token: CancellationToken,
) -> AppResult<()> {
    let settings = config::load(app)?;
    let secret_key = secret_key_for_provider(settings.provider);
    let secret = secrets::get(secret_key)?;

    // Phase 1 (sync, blocking): pre-render every referenced page into Send-safe
    // DynamicImages. `Arc<Pdfium>` is not `Send`, so we cannot hold it across
    // any later `.await`. Doing all rendering in one pass also amortises pdfium
    // setup across articles that share a page.
    let scale = page_scale(&req);
    let page_cache = {
        let state = app.state::<AppState>();
        let pdfium = state.pdfium.clone();
        prerender_pages(&pdfium, &req)?
    };

    // Phase 2 (async): OCR loop. Holds only `Send` data — page_cache (Arc<
    // DynamicImage>), settings, reqwest::Client, cancellation token.
    let client = app.state::<AppState>().http.clone();

    // Flatten the per-article block lists into one work queue. Each item
    // carries enough context to build a "报道N · 第k/M块" progress label
    // without re-looking-up the article afterwards.
    let mut items: Vec<WorkItem> = Vec::new();
    for article in &req.articles {
        let mut blocks = article.blocks.clone();
        blocks.sort_by_key(|b| b.order);
        let article_block_total = blocks.len();
        for (idx, block) in blocks.into_iter().enumerate() {
            items.push(WorkItem {
                article_id: article.id.clone(),
                article_num: article.num,
                article_block_idx: idx + 1,
                article_block_total,
                block,
            });
        }
    }
    let total: u32 = items.len() as u32;
    let job_id_str = job_id.to_string();

    // Emit immediately after prerender so the UI swaps "准备中…" for a real
    // status before any (much slower) OCR round-trip starts.
    let _ = app.emit(
        events::JOB_PROGRESS,
        ProgressEvent {
            job_id: job_id_str.clone(),
            done: 0,
            total,
            label: format!("页面已就绪 · 共 {} 块待识别", total),
            current_block: 0,
            article_total: 0,
        },
    );

    let page_cache = Arc::new(page_cache);
    let settings = Arc::new(settings);
    let secret_arc: Arc<Option<String>> = Arc::new(secret);
    let done_counter = Arc::new(AtomicU32::new(0));

    let outcomes: Vec<BlockOutcome> = stream::iter(items)
        .map(|item| {
            run_one_block(
                app.clone(),
                client.clone(),
                token.clone(),
                job_id_str.clone(),
                total,
                scale,
                Arc::clone(&page_cache),
                Arc::clone(&settings),
                Arc::clone(&secret_arc),
                Arc::clone(&done_counter),
                item,
            )
        })
        .buffer_unordered(OCR_CONCURRENCY)
        .collect()
        .await;

    let (results, errors, cancelled) = aggregate_outcomes(&req.articles, outcomes);

    let _ = app.emit(
        events::JOB_DONE,
        DoneEvent {
            job_id: job_id_str,
            results,
            errors,
            cancelled,
        },
    );
    Ok(())
}

/// One block's lifetime. Emits a "starting" progress event on entry, runs the
/// crop + encode + OCR pipeline, emits a "completed" event on success, and
/// returns a `BlockOutcome` for the aggregator. Always returns — never panics
/// — so the parent stream never short-circuits.
#[allow(clippy::too_many_arguments)]
async fn run_one_block(
    app: AppHandle,
    client: reqwest::Client,
    token: CancellationToken,
    job_id_str: String,
    total: u32,
    scale: f32,
    page_cache: Arc<HashMap<u32, Arc<DynamicImage>>>,
    settings: Arc<NonSecretSettings>,
    secret: Arc<Option<String>>,
    done_counter: Arc<AtomicU32>,
    item: WorkItem,
) -> BlockOutcome {
    if token.is_cancelled() {
        return BlockOutcome::Cancelled {
            article_id: item.article_id,
        };
    }

    let cur_done = done_counter.load(Ordering::SeqCst);
    let _ = app.emit(
        events::JOB_PROGRESS,
        ProgressEvent {
            job_id: job_id_str.clone(),
            done: cur_done,
            total,
            label: format!(
                "识别中 · 报道{} 第{}/{}块",
                item.article_num, item.article_block_idx, item.article_block_total
            ),
            current_block: item.article_block_idx as u32,
            article_total: item.article_block_total as u32,
        },
    );

    let Some(bitmap) = page_cache.get(&item.block.page) else {
        return BlockOutcome::Failed {
            article_id: item.article_id,
            message: format!("page {} 未预渲染 (内部错误)", item.block.page),
        };
    };

    let cropped = match crop_block(bitmap, &item.block.rect, scale) {
        Ok(c) => c,
        Err(e) => {
            return BlockOutcome::Failed {
                article_id: item.article_id,
                message: format!("block {} 裁切失败: {e}", item.block.block_id),
            }
        }
    };
    let b64 = match encode_png_b64(&cropped) {
        Ok(b) => b,
        Err(e) => {
            return BlockOutcome::Failed {
                article_id: item.article_id,
                message: format!("block {} 编码失败: {e}", item.block.block_id),
            }
        }
    };

    let prompt = settings.ocr_prompt.clone();
    let secret_ref: Option<&str> = secret.as_ref().as_deref();
    let ocr_call = ocr::recognize_with_retry(
        &client,
        &settings,
        secret_ref,
        OcrRequest {
            png_b64: &b64,
            prompt: &prompt,
        },
    );
    let recognized = tokio::select! {
        r = ocr_call => r,
        _ = token.cancelled() => {
            return BlockOutcome::Cancelled { article_id: item.article_id };
        }
    };

    match recognized {
        Ok(text) => {
            let n = done_counter.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = app.emit(
                events::JOB_PROGRESS,
                ProgressEvent {
                    job_id: job_id_str,
                    done: n,
                    total,
                    label: format!(
                        "完成 · 报道{} 第{}/{}块",
                        item.article_num, item.article_block_idx, item.article_block_total
                    ),
                    current_block: item.article_block_idx as u32,
                    article_total: item.article_block_total as u32,
                },
            );
            BlockOutcome::Done {
                article_id: item.article_id,
                order: item.block.order,
                text,
            }
        }
        Err(e) => BlockOutcome::Failed {
            article_id: item.article_id,
            message: format!("block {} OCR 失败: {e}", item.block.block_id),
        },
    }
}

/// Reduces per-block outcomes back into the article-level shape that the
/// frontend's JOB_DONE handler expects.
///
/// Semantics mirror the previous sequential implementation:
/// - An article with any cancelled block is dropped entirely (neither in
///   `results` nor `errors`). The frontend treats absent articles as
///   "untouched by this run" via the merge in `setArticleOcrTexts`.
/// - An article with any failed block goes to `errors` with the first failure
///   message — we don't aggregate multiple failures because the user only
///   acts on the article as a whole.
/// - An article with all blocks completed goes to `results` with the per-
///   block texts joined by `\n` in `block.order` ascending.
fn aggregate_outcomes(
    articles: &[ArticleOcrPlan],
    outcomes: Vec<BlockOutcome>,
) -> (Vec<ArticleResultPayload>, Vec<ArticleErrorPayload>, bool) {
    let mut texts_by_article: HashMap<String, Vec<(u32, String)>> = HashMap::new();
    let mut errors_by_article: HashMap<String, String> = HashMap::new();
    let mut cancelled_articles: HashSet<String> = HashSet::new();
    let mut cancelled = false;
    for o in outcomes {
        match o {
            BlockOutcome::Done {
                article_id,
                order,
                text,
            } => {
                texts_by_article
                    .entry(article_id)
                    .or_default()
                    .push((order, text));
            }
            BlockOutcome::Failed {
                article_id,
                message,
            } => {
                errors_by_article.entry(article_id).or_insert(message);
            }
            BlockOutcome::Cancelled { article_id } => {
                cancelled = true;
                cancelled_articles.insert(article_id);
            }
        }
    }

    let mut results: Vec<ArticleResultPayload> = Vec::new();
    let mut errors: Vec<ArticleErrorPayload> = Vec::new();
    for article in articles {
        if cancelled_articles.contains(&article.id) {
            continue;
        }
        if let Some(msg) = errors_by_article.remove(&article.id) {
            errors.push(ArticleErrorPayload {
                article_id: article.id.clone(),
                message: msg,
            });
            continue;
        }
        if let Some(mut blocks) = texts_by_article.remove(&article.id) {
            blocks.sort_by_key(|(o, _)| *o);
            let text = blocks
                .into_iter()
                .map(|(_, t)| t)
                .collect::<Vec<_>>()
                .join("\n");
            results.push(ArticleResultPayload {
                article_id: article.id.clone(),
                text,
            });
        }
    }
    (results, errors, cancelled)
}

/// One block's worth of work — small enough to copy cheaply between the
/// flatten step and the spawned task.
struct WorkItem {
    article_id: String,
    article_num: u32,
    article_block_idx: usize,
    article_block_total: usize,
    block: BlockRef,
}

enum BlockOutcome {
    Done {
        article_id: String,
        order: u32,
        text: String,
    },
    Failed {
        article_id: String,
        message: String,
    },
    Cancelled {
        article_id: String,
    },
}

fn prerender_pages(
    pdfium: &Arc<pdfium_render::prelude::Pdfium>,
    req: &GroupedOcrRequest,
) -> AppResult<HashMap<u32, Arc<DynamicImage>>> {
    let mut unique_pages: BTreeSet<u32> = BTreeSet::new();
    for article in &req.articles {
        for block in &article.blocks {
            unique_pages.insert(block.page);
        }
    }
    let mut cache = HashMap::new();
    for page in unique_pages {
        let bitmap = match req.kind {
            FileKind::Image => crate::image::load_from_disk(Path::new(&req.path))?,
            FileKind::Pdf => {
                let rendered =
                    pdf::render_page_with(pdfium, Path::new(&req.path), page, req.ocr_dpi)?;
                image::load_from_memory(&rendered.png_bytes)
                    .map_err(|e| AppError::Image(format!("decode rendered page: {e}")))?
            }
        };
        cache.insert(page, Arc::new(bitmap));
    }
    Ok(cache)
}

pub(super) fn secret_key_for_provider(p: Provider) -> SecretKey {
    match p {
        Provider::Paddleocr => SecretKey::PaddleToken,
        Provider::Openai => SecretKey::OpenaiKey,
        Provider::Openrouter => SecretKey::OpenrouterKey,
        Provider::OpenaiCompatible => SecretKey::OpenaiCompatibleKey,
    }
}

/// PDF blocks are stored in preview-pixel coordinates; rendering at `ocr_dpi`
/// gives a larger bitmap, so block rects must scale up by `ocr_dpi /
/// preview_dpi`. Image files have a single native resolution — no scaling.
fn page_scale(req: &GroupedOcrRequest) -> f32 {
    match req.kind {
        FileKind::Image => 1.0,
        FileKind::Pdf if req.preview_dpi > 0 => req.ocr_dpi as f32 / req.preview_dpi as f32,
        FileKind::Pdf => 1.0,
    }
}

/// Crops a rectangle from `bitmap`. Scales the user-supplied rect by `scale`
/// before sampling — for PDFs that's `ocr_dpi/preview_dpi`; for images it's
/// `1.0`. Returns the intersection of the rect and the bitmap bounds when the
/// rect partially exceeds them, and errors when there is no overlap at all.
pub fn crop_block(bitmap: &DynamicImage, rect: &Rect, scale: f32) -> AppResult<DynamicImage> {
    let (w, h) = bitmap.dimensions();
    let raw_x = (rect.x * scale).round().max(0.0) as u32;
    let raw_y = (rect.y * scale).round().max(0.0) as u32;
    let raw_w = (rect.width * scale).round().max(1.0) as u32;
    let raw_h = (rect.height * scale).round().max(1.0) as u32;

    let x_max = raw_x.saturating_add(raw_w).min(w);
    let y_max = raw_y.saturating_add(raw_h).min(h);
    if raw_x >= w || raw_y >= h || raw_x >= x_max || raw_y >= y_max {
        return Err(AppError::Image(format!(
            "block crop is outside the page bitmap ({w}x{h})"
        )));
    }
    let cw = x_max - raw_x;
    let ch = y_max - raw_y;
    Ok(bitmap.crop_imm(raw_x, raw_y, cw, ch))
}

pub(super) fn encode_png_b64(img: &DynamicImage) -> AppResult<String> {
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| AppError::Image(format!("crop png encode: {e}")))?;
    Ok(STANDARD.encode(buf.into_inner()))
}

/// Pre-flight validation called by the `start_grouped_ocr` command before
/// spawning the worker. Returning `Err` lets the command refuse the request
/// up front instead of emitting an empty done event.
pub fn validate(req: &GroupedOcrRequest) -> AppResult<()> {
    if req.path.is_empty() {
        return Err(AppError::Config("缺少文件路径".into()));
    }
    if req.articles.is_empty() {
        return Err(AppError::Config("没有可识别的报道".into()));
    }
    for article in &req.articles {
        if article.blocks.is_empty() {
            return Err(AppError::Config(format!("报道 {} 没有版块", article.title)));
        }
    }
    if req.ocr_dpi == 0 {
        return Err(AppError::Config("ocr_dpi 必须大于 0".into()));
    }
    if matches!(req.kind, FileKind::Pdf) && req.preview_dpi == 0 {
        return Err(AppError::Config("PDF 必须提供 preview_dpi".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    fn flat_image(w: u32, h: u32) -> DynamicImage {
        let buf: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_pixel(w, h, Rgba([1, 2, 3, 255]));
        DynamicImage::ImageRgba8(buf)
    }

    fn make_req(kind: FileKind) -> GroupedOcrRequest {
        GroupedOcrRequest {
            file_id: "f1".into(),
            path: "/tmp/x.pdf".into(),
            kind,
            preview_dpi: 150,
            ocr_dpi: 300,
            articles: vec![ArticleOcrPlan {
                id: "a1".into(),
                title: "T".into(),
                num: 1,
                blocks: vec![BlockRef {
                    page: 1,
                    block_id: "b1".into(),
                    rect: Rect {
                        x: 0.0,
                        y: 0.0,
                        width: 10.0,
                        height: 10.0,
                    },
                    order: 1,
                }],
            }],
            newspaper_name: String::new(),
            newspaper_date: String::new(),
        }
    }

    #[test]
    fn page_scale_image_is_one() {
        let r = make_req(FileKind::Image);
        assert!((page_scale(&r) - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn page_scale_pdf_uses_dpi_ratio() {
        let r = make_req(FileKind::Pdf);
        assert!((page_scale(&r) - 2.0).abs() < f32::EPSILON);
    }

    #[test]
    fn page_scale_pdf_with_zero_preview_dpi_falls_back_to_one() {
        let mut r = make_req(FileKind::Pdf);
        r.preview_dpi = 0;
        assert!((page_scale(&r) - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn crop_block_scales_input_rect() {
        let img = flat_image(200, 100);
        let rect = Rect {
            x: 10.0,
            y: 10.0,
            width: 20.0,
            height: 30.0,
        };
        // scale = 2 → expected crop is (20, 20, 40, 60)
        let out = crop_block(&img, &rect, 2.0).unwrap();
        assert_eq!(out.dimensions(), (40, 60));
    }

    #[test]
    fn crop_block_clamps_to_image_bounds() {
        let img = flat_image(50, 50);
        let rect = Rect {
            x: 40.0,
            y: 40.0,
            width: 100.0,
            height: 100.0,
        };
        let out = crop_block(&img, &rect, 1.0).unwrap();
        // 50-40 = 10 in both dims; bitmap[40..50, 40..50]
        assert_eq!(out.dimensions(), (10, 10));
    }

    #[test]
    fn crop_block_entirely_outside_errors() {
        let img = flat_image(50, 50);
        let rect = Rect {
            x: 100.0,
            y: 100.0,
            width: 10.0,
            height: 10.0,
        };
        let err = crop_block(&img, &rect, 1.0).unwrap_err();
        assert!(matches!(err, AppError::Image(_)));
    }

    #[test]
    fn encode_png_b64_returns_valid_data() {
        let img = flat_image(2, 2);
        let b64 = encode_png_b64(&img).unwrap();
        let raw = STANDARD.decode(b64).unwrap();
        assert!(raw.starts_with(b"\x89PNG\r\n\x1a\n"));
    }

    #[test]
    fn validate_rejects_empty_articles() {
        let mut r = make_req(FileKind::Pdf);
        r.articles.clear();
        assert!(validate(&r).is_err());
    }

    #[test]
    fn validate_rejects_article_with_no_blocks() {
        let mut r = make_req(FileKind::Pdf);
        r.articles[0].blocks.clear();
        assert!(validate(&r).is_err());
    }

    #[test]
    fn validate_rejects_pdf_with_zero_preview_dpi() {
        let mut r = make_req(FileKind::Pdf);
        r.preview_dpi = 0;
        assert!(validate(&r).is_err());
    }

    #[test]
    fn validate_passes_for_image_with_zero_preview_dpi() {
        let mut r = make_req(FileKind::Image);
        r.preview_dpi = 0;
        assert!(validate(&r).is_ok());
    }

    #[test]
    fn secret_key_matches_each_provider() {
        assert_eq!(
            secret_key_for_provider(Provider::Paddleocr),
            SecretKey::PaddleToken
        );
        assert_eq!(
            secret_key_for_provider(Provider::Openai),
            SecretKey::OpenaiKey
        );
        assert_eq!(
            secret_key_for_provider(Provider::Openrouter),
            SecretKey::OpenrouterKey
        );
        assert_eq!(
            secret_key_for_provider(Provider::OpenaiCompatible),
            SecretKey::OpenaiCompatibleKey
        );
    }
}
