//! Whole-file OCR job runner.
//!
//! Two execution strategies, picked at runtime from the active provider:
//!
//! - **Page-image path** (default for OpenAI / OpenRouter / OpenAI-Compatible,
//!   and Paddle on image files): one OCR call per page. Bitmaps are pulled
//!   lazily through [`PageLoader`] so peak memory stays bounded.
//!
//! - **Paddle document path** (Paddle + PDF): the full PDF is uploaded once
//!   via the Paddle document-level API with a `pageRanges` filter, then
//!   the JSONL result is parsed into per-page text. This is roughly
//!   matches the Paddle web demo and gives much better layout-aware
//!   recognition than slicing the PDF into per-page PNGs ourselves.
//!   When the source file exceeds Paddle's 50 MB multipart cap or the
//!   1000-page hard ceiling, this path further splits the request into
//!   chunk PDFs via [`crate::pdf_chunk`], submits each chunk separately,
//!   and reassembles results onto the original PDF's page numbers
//!   before reporting back. The chunk submission stays invisible to
//!   the UI — chunk-local page numbers never leave the runner.
//!
//! All three sub-paths emit `JOB_PROGRESS` events and resolve to the
//! same `DoneEvent` shape, with a `source` discriminator so the frontend
//! can tag results with the right `RecognizedPageSourceMode`.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::grouped::{encode_ocr_jpeg, secret_key_for_provider, FileKind};
use super::{page_loader::PageLoader, JobEventKind};
use crate::config::{self, Provider};
use crate::error::{AppError, AppResult};
use crate::ocr::{
    self, document_poll_timeout, paddle_document, paddle_json::LayoutPage, OcrRequest,
    PADDLE_POLL_INTERVAL,
};
use crate::pdf_chunk::{self, ChunkConfig, ChunkStrategy};
use crate::state::AppState;

// Per-provider in-flight OCR call ceiling lives in `ocr::concurrency_for`.

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct WholeFileOcrRequest {
    pub file_id: String,
    pub path: String,
    pub kind: FileKind,
    pub pages: Vec<u32>,
    /// Legacy / informational only — see [`super::grouped::GroupedOcrRequest`].
    /// The backend pulls the OCR-grade render DPI from `settings.ocr_profile`.
    #[serde(default)]
    pub ocr_dpi: u32,
    #[serde(default)]
    pub newspaper_name: String,
    #[serde(default)]
    pub newspaper_date: String,
}

#[derive(Debug, Clone, Serialize)]
struct ProgressEvent {
    job_id: String,
    done: u32,
    total: u32,
    label: String,
}

#[derive(Debug, Clone, Serialize)]
struct PageResultPayload {
    page: u32,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    layout: Option<LayoutPage>,
    /// Set only on the chunked Paddle path. The chunk id is the local
    /// manifest identifier (`chunk-001`, `chunk-002`, ...); the chunk
    /// page is the 1-based position inside that chunk PDF. Both are
    /// purely informational — the UI keys results off `page` (the
    /// original PDF page) and never displays chunk pagination.
    #[serde(skip_serializing_if = "Option::is_none")]
    chunk_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chunk_page: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
struct PageErrorPayload {
    page: u32,
    message: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum DoneSource {
    PageImage,
    PaddleDocument,
    PaddleDocumentChunk,
}

#[derive(Debug, Clone, Serialize)]
struct DoneEvent {
    job_id: String,
    results: Vec<PageResultPayload>,
    errors: Vec<PageErrorPayload>,
    cancelled: bool,
    source: DoneSource,
}

#[derive(Debug, Clone, Serialize)]
struct ErrorEvent {
    job_id: String,
    error: String,
}

pub fn spawn(
    state: Arc<AppState>,
    req: WholeFileOcrRequest,
    job_id: Uuid,
    token: CancellationToken,
) {
    spawn_inner(state, req, job_id, token, None);
}

pub fn spawn_with_settings(
    state: Arc<AppState>,
    req: WholeFileOcrRequest,
    job_id: Uuid,
    token: CancellationToken,
    settings: config::NonSecretSettings,
) {
    spawn_inner(state, req, job_id, token, Some(settings));
}

fn spawn_inner(
    state: Arc<AppState>,
    req: WholeFileOcrRequest,
    job_id: Uuid,
    token: CancellationToken,
    settings: Option<config::NonSecretSettings>,
) {
    tokio::spawn(async move {
        let outcome = run(Arc::clone(&state), req, job_id, token, settings).await;
        state.jobs.remove(job_id);
        if let Err(e) = outcome {
            log::error!("whole-file ocr job {job_id} crashed: {e}");
            state.events.emit(
                JobEventKind::Error,
                ErrorEvent {
                    job_id: job_id.to_string(),
                    error: e.to_string(),
                },
            );
        }
    });
}

async fn run(
    state: Arc<AppState>,
    req: WholeFileOcrRequest,
    job_id: Uuid,
    token: CancellationToken,
    settings: Option<config::NonSecretSettings>,
) -> AppResult<()> {
    let settings = match settings {
        Some(settings) => settings,
        None => config::load(&state.data_dir)?,
    };
    let secret_key = secret_key_for_provider(settings.provider);
    let secret = state.secrets.get(secret_key).await?;
    let job_id_str = job_id.to_string();

    // Route Paddle + PDF to the document-level path. Everything else (any
    // image file, or any non-Paddle provider) keeps using the per-page PNG
    // pipeline so OpenAI / OpenRouter still see one image per call.
    if settings.provider == Provider::Paddleocr && matches!(req.kind, FileKind::Pdf) {
        return run_paddle_document(state, req, job_id_str, token, settings, secret).await;
    }
    run_page_image(state, req, job_id_str, token, settings, secret).await
}

async fn run_page_image(
    state: Arc<AppState>,
    req: WholeFileOcrRequest,
    job_id_str: String,
    token: CancellationToken,
    settings: config::NonSecretSettings,
    secret: Option<String>,
) -> AppResult<()> {
    let total = req.pages.len() as u32;
    // Backend-derived (see `OcrProfile::ocr_dpi`); request DTO field is
    // ignored.
    let ocr_dpi = settings.ocr_profile.ocr_dpi();

    // Lazy bitmap loader. The LRU capacity tracks the provider's worker-pool
    // width plus one slack slot, so peak memory stays at a handful of decoded
    // pages instead of the full requested range.
    let concurrency = ocr::concurrency_for(settings.provider);
    let loader = Arc::new(PageLoader::new(
        Arc::clone(&state),
        req.kind,
        PathBuf::from(&req.path),
        ocr_dpi,
        concurrency + 1,
    ));
    let client = state.http.clone();

    state.events.emit(
        JobEventKind::Progress,
        ProgressEvent {
            job_id: job_id_str.clone(),
            done: 0,
            total,
            label: format!("准备识别 · 共 {} 页", total),
        },
    );

    let settings = Arc::new(settings);
    let secret_arc: Arc<Option<String>> = Arc::new(secret);
    let done_counter = Arc::new(AtomicU32::new(0));

    let outcomes: Vec<PageOutcome> = stream::iter(req.pages.clone().into_iter().enumerate())
        .map(|(idx, page)| {
            run_one_page(
                Arc::clone(&state),
                client.clone(),
                token.clone(),
                job_id_str.clone(),
                total,
                Arc::clone(&loader),
                Arc::clone(&settings),
                Arc::clone(&secret_arc),
                Arc::clone(&done_counter),
                page,
                idx + 1,
            )
        })
        .buffer_unordered(concurrency)
        .collect()
        .await;

    let mut results: Vec<PageResultPayload> = Vec::new();
    let mut errors: Vec<PageErrorPayload> = Vec::new();
    let mut cancelled = false;
    for o in outcomes {
        match o {
            PageOutcome::Done { page, text } => results.push(PageResultPayload {
                page,
                text,
                layout: None,
                chunk_id: None,
                chunk_page: None,
            }),
            PageOutcome::Failed { page, message } => {
                errors.push(PageErrorPayload { page, message })
            }
            PageOutcome::Cancelled => cancelled = true,
        }
    }

    state.events.emit(
        JobEventKind::Done,
        DoneEvent {
            job_id: job_id_str,
            results,
            errors,
            cancelled,
            source: DoneSource::PageImage,
        },
    );
    Ok(())
}

/// Snapshot of Paddle-specific settings carved out of `NonSecretSettings`
/// so the chunked and direct paths share one resolution site instead of
/// repeating the empty-string-fallback dance.
struct PaddleEndpoint<'a> {
    job_url: &'a str,
    model: &'a str,
}

fn resolve_paddle_endpoint(settings: &config::NonSecretSettings) -> PaddleEndpoint<'_> {
    let job_url = if settings.paddle_url.is_empty() {
        crate::ocr::paddle::DEFAULT_JOB_URL
    } else {
        settings.paddle_url.as_str()
    };
    let model = if settings.paddle_model.is_empty() {
        crate::ocr::paddle::DEFAULT_MODEL
    } else {
        settings.paddle_model.as_str()
    };
    PaddleEndpoint { job_url, model }
}

/// Normalize the request's requested pages once at job entry: sorted
/// ascending and deduplicated. Every downstream consumer (strategy
/// decision, chunk planning, `pageRanges` string, JSONL line→page
/// reassembly) reads from this single Vec — that's the fix for the
/// implicit ordering coupling between `paddle_document::pages_to_ranges_string`
/// (which sorts internally) and `paddle_document::map_lines_to_pages`
/// (which zips by caller order). `validate()` already rejects duplicates
/// and zeros up front, so this is mostly defensive against future regressions.
fn normalize_requested_pages(raw: &[u32]) -> Vec<u32> {
    let mut v = raw.to_vec();
    v.sort_unstable();
    v.dedup();
    v
}

async fn run_paddle_document(
    state: Arc<AppState>,
    req: WholeFileOcrRequest,
    job_id_str: String,
    token: CancellationToken,
    settings: config::NonSecretSettings,
    secret: Option<String>,
) -> AppResult<()> {
    let pages_sorted = normalize_requested_pages(&req.pages);
    let total = pages_sorted.len() as u32;
    state.events.emit(
        JobEventKind::Progress,
        ProgressEvent {
            job_id: job_id_str.clone(),
            done: 0,
            total,
            label: format!("提交文档 · 共 {} 页", total),
        },
    );

    // Strategy decision is driven by observable file metadata: on-disk
    // size against Paddle's 50 MB multipart cap, and the *source* PDF's
    // page count against the 1000-page hard ceiling. The user's
    // requested page subset doesn't change either limit — Paddle counts
    // the submitted file as a whole.
    let source_size_bytes = tokio::fs::metadata(&req.path)
        .await
        .map_err(|e| AppError::Internal(format!("stat {}: {e}", req.path)))?
        .len();
    let source_page_count = state.pdf.info(PathBuf::from(&req.path)).await?.page_count;
    let strategy = pdf_chunk::decide_strategy(source_size_bytes, source_page_count);

    match strategy {
        ChunkStrategy::DirectMultipart => {
            run_paddle_document_direct(
                Arc::clone(&state),
                &req.path,
                job_id_str,
                token,
                &settings,
                secret.as_deref(),
                pages_sorted,
            )
            .await
        }
        ChunkStrategy::Chunked => {
            run_paddle_document_chunked(
                state,
                &req.path,
                job_id_str,
                token,
                &settings,
                secret.as_deref(),
                pages_sorted,
                source_size_bytes,
                source_page_count,
            )
            .await
        }
    }
}

async fn run_paddle_document_direct(
    state: Arc<AppState>,
    source_path: &str,
    job_id_str: String,
    token: CancellationToken,
    settings: &config::NonSecretSettings,
    secret: Option<&str>,
    pages_sorted: Vec<u32>,
) -> AppResult<()> {
    let client = state.http.clone();
    let endpoint = resolve_paddle_endpoint(settings);
    let paddle_token = secret.unwrap_or("");
    let file_name = std::path::Path::new(source_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("document.pdf")
        .to_string();

    let page_ranges = paddle_document::pages_to_ranges_string(&pages_sorted);
    let job_id_for_progress = job_id_str.clone();
    let state_for_progress = Arc::clone(&state);
    let mut on_progress = move |done: u32, total_pages: u32| {
        state_for_progress.events.emit(
            JobEventKind::Progress,
            ProgressEvent {
                job_id: job_id_for_progress.clone(),
                done,
                total: total_pages.max(1),
                label: format!("识别中 · 已完成 {}/{} 页", done, total_pages),
            },
        );
    };

    let outcome = paddle_document::recognize_document(
        &client,
        endpoint.job_url,
        paddle_token,
        endpoint.model,
        PathBuf::from(source_path),
        "application/pdf",
        &file_name,
        Some(page_ranges),
        paddle_document::document_payload(&settings.paddle_document_options),
        pages_sorted.clone(),
        PADDLE_POLL_INTERVAL,
        document_poll_timeout(pages_sorted.len()),
        &token,
        &mut on_progress,
    )
    .await;

    let mut results: Vec<PageResultPayload> = Vec::new();
    let mut errors: Vec<PageErrorPayload> = Vec::new();
    let mut cancelled = false;
    match outcome {
        Ok(pages) => {
            for entry in pages {
                if entry.text.is_empty() {
                    errors.push(PageErrorPayload {
                        page: entry.page,
                        message: "文档识别未返回该页文本".to_string(),
                    });
                } else {
                    results.push(PageResultPayload {
                        page: entry.page,
                        text: entry.text,
                        layout: entry.layout,
                        chunk_id: None,
                        chunk_page: None,
                    });
                }
            }
        }
        Err(AppError::Cancelled(_)) => {
            cancelled = true;
        }
        Err(e) => {
            // Surface the failure as a single per-page error per requested
            // page so the UI can still light up each row in red, then return
            // OK below — the DoneEvent carries the cancelled / error state.
            let message = e.to_string();
            for page in &pages_sorted {
                errors.push(PageErrorPayload {
                    page: *page,
                    message: message.clone(),
                });
            }
        }
    }

    state.events.emit(
        JobEventKind::Done,
        DoneEvent {
            job_id: job_id_str,
            results,
            errors,
            cancelled,
            source: DoneSource::PaddleDocument,
        },
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_paddle_document_chunked(
    state: Arc<AppState>,
    source_path: &str,
    job_id_str: String,
    token: CancellationToken,
    settings: &config::NonSecretSettings,
    secret: Option<&str>,
    pages_sorted: Vec<u32>,
    source_size_bytes: u64,
    source_page_count: u32,
) -> AppResult<()> {
    let client = state.http.clone();
    let endpoint = resolve_paddle_endpoint(settings);
    let paddle_token = secret.unwrap_or("");
    let total = pages_sorted.len() as u32;
    let chunk_config = ChunkConfig::default();

    state.events.emit(
        JobEventKind::Progress,
        ProgressEvent {
            job_id: job_id_str.clone(),
            done: 0,
            total,
            label: format!("准备分块 · 共 {} 页", total),
        },
    );

    let chunk_output = match state
        .pdf
        .build_chunks(
            PathBuf::from(source_path),
            pages_sorted.clone(),
            source_size_bytes,
            source_page_count,
            chunk_config,
        )
        .await
    {
        Ok(out) => out,
        Err(e) => {
            // Chunking failures (over-size single page, pdfium error, ...)
            // are hard config/runtime errors — emit them as one failed
            // page per requested page so the UI rows light up and the
            // user sees the actionable message ("please pre-compress").
            let message = e.to_string();
            let errors = pages_sorted
                .iter()
                .map(|p| PageErrorPayload {
                    page: *p,
                    message: message.clone(),
                })
                .collect();
            state.events.emit(
                JobEventKind::Done,
                DoneEvent {
                    job_id: job_id_str,
                    results: Vec::new(),
                    errors,
                    cancelled: false,
                    source: DoneSource::PaddleDocumentChunk,
                },
            );
            return Ok(());
        }
    };

    let total_chunk_bytes: u64 = chunk_output
        .manifests
        .iter()
        .map(|manifest| manifest.size_bytes)
        .sum();
    log::info!(
        "built {} Paddle OCR chunks totalling {:.1} MB in {}",
        chunk_output.manifests.len(),
        total_chunk_bytes as f64 / 1_048_576.0,
        chunk_output.temp_dir_path().display()
    );

    let mut results: Vec<PageResultPayload> = Vec::new();
    let mut errors: Vec<PageErrorPayload> = Vec::new();
    let mut cancelled = false;
    let mut completed_so_far: u32 = 0;

    for (chunk_idx, manifest) in chunk_output.manifests.iter().enumerate() {
        if token.is_cancelled() {
            cancelled = true;
            break;
        }
        let chunk_len = manifest.original_pages.len() as u32;
        let chunk_local_pages: Vec<u32> = (1..=chunk_len).collect();
        let chunk_page_ranges = paddle_document::pages_to_ranges_string(&chunk_local_pages);
        let chunk_file_name = format!("{}.pdf", manifest.chunk_id);

        state.events.emit(
            JobEventKind::Progress,
            ProgressEvent {
                job_id: job_id_str.clone(),
                done: completed_so_far,
                total,
                label: format!(
                    "提交分块 {}/{} · {} 页",
                    chunk_idx + 1,
                    chunk_output.manifests.len(),
                    chunk_len
                ),
            },
        );

        // Per-chunk progress is reported by paddle_document via the
        // `extractProgress.extractedPages` field. Aggregate into a
        // job-wide counter so the UI sees a single monotonically-
        // increasing fraction across all chunks.
        let job_id_for_progress = job_id_str.clone();
        let state_for_progress = Arc::clone(&state);
        let chunk_idx_for_progress = chunk_idx + 1;
        let chunk_total_for_progress = chunk_output.manifests.len();
        let base_done_for_progress = completed_so_far;
        let mut on_progress = move |chunk_done: u32, chunk_total: u32| {
            let aggregate_done = base_done_for_progress.saturating_add(chunk_done.min(chunk_total));
            state_for_progress.events.emit(
                JobEventKind::Progress,
                ProgressEvent {
                    job_id: job_id_for_progress.clone(),
                    done: aggregate_done,
                    total,
                    label: format!(
                        "分块 {}/{} 识别中 · 已完成 {}/{} 页",
                        chunk_idx_for_progress, chunk_total_for_progress, chunk_done, chunk_total
                    ),
                },
            );
        };

        let outcome = paddle_document::recognize_document(
            &client,
            endpoint.job_url,
            paddle_token,
            endpoint.model,
            manifest.chunk_pdf_path.clone(),
            "application/pdf",
            &chunk_file_name,
            Some(chunk_page_ranges),
            paddle_document::document_payload(&settings.paddle_document_options),
            chunk_local_pages,
            PADDLE_POLL_INTERVAL,
            document_poll_timeout(chunk_len as usize),
            &token,
            &mut on_progress,
        )
        .await;

        match outcome {
            Ok(chunk_results) => {
                for entry in chunk_results {
                    // entry.page is *chunk-local*. Translate back to the
                    // original PDF's page number via the manifest — this
                    // is the only place chunk-local page numbers leak
                    // beyond paddle_document.
                    let Some(original_page) = manifest.original_page(entry.page) else {
                        // Paddle returned a page we didn't ask for; log
                        // and skip rather than panic.
                        log::warn!(
                            "chunk {} returned out-of-range chunk_page={} (chunk size {})",
                            manifest.chunk_id,
                            entry.page,
                            manifest.original_pages.len()
                        );
                        continue;
                    };
                    if entry.text.is_empty() {
                        errors.push(PageErrorPayload {
                            page: original_page,
                            message: "文档识别未返回该页文本".to_string(),
                        });
                    } else {
                        let layout = entry.layout.map(|mut layout| {
                            layout.index = original_page;
                            layout
                        });
                        results.push(PageResultPayload {
                            page: original_page,
                            text: entry.text,
                            layout,
                            chunk_id: Some(manifest.chunk_id.clone()),
                            chunk_page: Some(entry.page),
                        });
                    }
                }
            }
            Err(AppError::Cancelled(_)) => {
                cancelled = true;
                break;
            }
            Err(e) => {
                // A single chunk failed mid-job. Mark every original page
                // covered by this chunk as failed, then keep going — the
                // user may still get usable results from the surviving
                // chunks. Stop only on cancel.
                let message = e.to_string();
                for original_page in &manifest.original_pages {
                    errors.push(PageErrorPayload {
                        page: *original_page,
                        message: message.clone(),
                    });
                }
            }
        }

        completed_so_far = completed_so_far.saturating_add(chunk_len);
    }

    // Holding `chunk_output` until here keeps the TempDir alive so chunk
    // PDFs survive until we're done uploading them. The drop on the next
    // line removes them all in one shot.
    drop(chunk_output);

    state.events.emit(
        JobEventKind::Done,
        DoneEvent {
            job_id: job_id_str,
            results,
            errors,
            cancelled,
            source: DoneSource::PaddleDocumentChunk,
        },
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_one_page(
    state: Arc<AppState>,
    client: reqwest::Client,
    token: CancellationToken,
    job_id_str: String,
    total: u32,
    loader: Arc<PageLoader>,
    settings: Arc<config::NonSecretSettings>,
    secret: Arc<Option<String>>,
    done_counter: Arc<AtomicU32>,
    page: u32,
    page_idx: usize,
) -> PageOutcome {
    if token.is_cancelled() {
        return PageOutcome::Cancelled;
    }

    let cur_done = done_counter.load(Ordering::SeqCst);
    state.events.emit(
        JobEventKind::Progress,
        ProgressEvent {
            job_id: job_id_str.clone(),
            done: cur_done,
            total,
            label: format!("识别中 · 第{}/{}页", page_idx, total),
        },
    );

    let bitmap = match loader.get(page, &token).await {
        Ok(b) => b,
        Err(AppError::Cancelled(_)) => return PageOutcome::Cancelled,
        Err(e) => {
            return PageOutcome::Failed {
                page,
                message: format!("page {} 加载失败: {e}", page),
            }
        }
    };

    // JPEG-encoding a full 300-DPI page is pure-CPU work that can take
    // seconds; run it on the blocking pool so concurrent page workers don't
    // pin tokio worker threads.
    let bitmap_for_encode = Arc::clone(&bitmap);
    let encoded = tokio::task::spawn_blocking(move || encode_ocr_jpeg(&bitmap_for_encode))
        .await
        .map_err(|e| AppError::Internal(format!("encode task join: {e}")))
        .and_then(|inner| inner);
    let image_bytes = match encoded {
        Ok(b) => b,
        Err(e) => {
            return PageOutcome::Failed {
                page,
                message: format!("page {} 编码失败: {e}", page),
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
            image_bytes: &image_bytes,
            prompt: &prompt,
        },
        &token,
    );
    let recognized = tokio::select! {
        r = ocr_call => r,
        _ = token.cancelled() => {
            return PageOutcome::Cancelled;
        }
    };

    match recognized {
        Ok(text) => {
            let n = done_counter.fetch_add(1, Ordering::SeqCst) + 1;
            state.events.emit(
                JobEventKind::Progress,
                ProgressEvent {
                    job_id: job_id_str,
                    done: n,
                    total,
                    label: format!("完成 · 第{}/{}页", page_idx, total),
                },
            );
            PageOutcome::Done { page, text }
        }
        Err(AppError::Cancelled(_)) => PageOutcome::Cancelled,
        Err(e) => PageOutcome::Failed {
            page,
            message: format!("page {} OCR 失败: {e}", page),
        },
    }
}

enum PageOutcome {
    Done { page: u32, text: String },
    Failed { page: u32, message: String },
    Cancelled,
}

/// Per-(provider, kind) request-page cap, picked based on which sub-path
/// the runner will dispatch into:
///
/// - **Page-image path** (anything that's not Paddle+Pdf) does one
///   network round-trip per page. At ~20 s/page on a healthy provider,
///   500 pages is already ~3 h of wall time; past that the user is
///   better served by splitting the file so cancel/retry granularity
///   stays sane.
/// - **Paddle document path** (Paddle + Pdf) ships every page in one
///   async job (or a small handful of chunks). Wall-clock no longer
///   scales linearly with the requested page count, so the binding
///   constraint shifts to Paddle's own 1000-page-per-file hard limit
///   — and chunking lifts even that for the source PDF, since each
///   chunk is sent on its own.
fn max_pages_for(provider: Provider, kind: FileKind) -> u32 {
    match (provider, kind) {
        (Provider::Paddleocr, FileKind::Pdf) => 1000,
        _ => 500,
    }
}

pub fn validate(req: &WholeFileOcrRequest, settings: &config::NonSecretSettings) -> AppResult<()> {
    if req.path.is_empty() {
        return Err(AppError::Config("缺少文件路径".into()));
    }
    if req.pages.is_empty() {
        return Err(AppError::Config("没有可识别的页面".into()));
    }
    if req.pages.contains(&0) {
        return Err(AppError::Config("页码从 1 开始，不能为 0".into()));
    }
    if matches!(req.kind, FileKind::Image) && req.pages.iter().any(|page| *page != 1) {
        return Err(AppError::Config("图片文件只能识别第 1 页".into()));
    }
    let mut seen = HashSet::with_capacity(req.pages.len());
    for page in &req.pages {
        if !seen.insert(*page) {
            return Err(AppError::Config(format!("页码重复：{page}")));
        }
    }
    // Strict-ascending contract with the frontend. `PageRangePlan` already
    // hands us sorted pages, but enforcing the invariant here turns the
    // implicit coupling into a checked one — the Paddle document path
    // relies on `pages_to_ranges_string`'s sorted output lining up with
    // `map_jsonl_pages_to_requested`'s caller-order zip, and a regression to either
    // side would have produced silently mis-mapped page numbers without
    // this check.
    if !req.pages.windows(2).all(|w| w[0] < w[1]) {
        return Err(AppError::Config("页码必须严格升序".into()));
    }
    let max_pages = max_pages_for(settings.provider, req.kind);
    if req.pages.len() as u32 > max_pages {
        let hint = if max_pages == 1000 {
            "（Paddle 文档级 OCR 单次最多 1000 页，请拆分输入或减少页码范围）"
        } else {
            "（建议拆分大文件以获得更短的反馈周期）"
        };
        return Err(AppError::Config(format!(
            "单次最多识别 {} 页{}",
            max_pages, hint
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::OcrProfile;

    fn settings_with(provider: Provider) -> config::NonSecretSettings {
        config::NonSecretSettings {
            provider,
            ocr_profile: OcrProfile::Standard,
            ocr_prompt: String::new(),
            paddle_url: String::new(),
            paddle_model: String::new(),
            paddle_document_options: config::PaddleDocumentOptions::default(),
            openai_model: String::new(),
            openrouter_model: String::new(),
            openai_compatible_base_url: String::new(),
            openai_compatible_model: String::new(),
        }
    }

    fn make_req(pages: Vec<u32>) -> WholeFileOcrRequest {
        WholeFileOcrRequest {
            file_id: "f1".into(),
            path: "/tmp/x.jpg".into(),
            kind: FileKind::Image,
            pages,
            ocr_dpi: 300,
            newspaper_name: String::new(),
            newspaper_date: String::new(),
        }
    }

    #[test]
    fn validate_rejects_empty_pages() {
        let r = make_req(vec![]);
        assert!(validate(&r, &settings_with(Provider::Paddleocr)).is_err());
    }

    #[test]
    fn validate_passes_basic() {
        let r = make_req(vec![1, 2, 3]);
        let r = WholeFileOcrRequest {
            kind: FileKind::Pdf,
            ..r
        };
        assert!(validate(&r, &settings_with(Provider::Paddleocr)).is_ok());
    }

    #[test]
    fn validate_rejects_page_zero() {
        let r = make_req(vec![0, 1]);
        assert!(validate(&r, &settings_with(Provider::Paddleocr)).is_err());
    }

    #[test]
    fn validate_rejects_duplicate_pages() {
        let r = make_req(vec![1, 2, 2]);
        let r = WholeFileOcrRequest {
            kind: FileKind::Pdf,
            ..r
        };
        assert!(validate(&r, &settings_with(Provider::Paddleocr)).is_err());
    }

    #[test]
    fn validate_rejects_non_first_image_page() {
        let r = make_req(vec![2]);
        assert!(validate(&r, &settings_with(Provider::Paddleocr)).is_err());
    }

    #[test]
    fn validate_paddle_pdf_allows_up_to_1000_pages() {
        let pages: Vec<u32> = (1..=1000).collect();
        let r = WholeFileOcrRequest {
            kind: FileKind::Pdf,
            ..make_req(pages)
        };
        assert!(validate(&r, &settings_with(Provider::Paddleocr)).is_ok());
    }

    #[test]
    fn validate_paddle_pdf_rejects_over_1000_pages() {
        let pages: Vec<u32> = (1..=1001).collect();
        let r = WholeFileOcrRequest {
            kind: FileKind::Pdf,
            ..make_req(pages)
        };
        let err = validate(&r, &settings_with(Provider::Paddleocr)).unwrap_err();
        match err {
            AppError::Config(msg) => assert!(msg.contains("1000"), "{msg}"),
            other => panic!("expected Config, got {other:?}"),
        }
    }

    #[test]
    fn validate_page_image_path_keeps_500_cap() {
        // OpenAI + Pdf takes the per-page network path, so the 500-page
        // sane-feedback-cycle cap still applies.
        let pages: Vec<u32> = (1..=501).collect();
        let r = WholeFileOcrRequest {
            kind: FileKind::Pdf,
            ..make_req(pages)
        };
        let err = validate(&r, &settings_with(Provider::Openai)).unwrap_err();
        match err {
            AppError::Config(msg) => assert!(msg.contains("500"), "{msg}"),
            other => panic!("expected Config, got {other:?}"),
        }
    }

    #[test]
    fn normalize_requested_pages_sorts_and_dedupes() {
        assert_eq!(normalize_requested_pages(&[5, 1, 3, 1, 5]), vec![1, 3, 5]);
        assert_eq!(normalize_requested_pages(&[]), Vec::<u32>::new());
        assert_eq!(normalize_requested_pages(&[7]), vec![7]);
    }

    #[test]
    fn validate_rejects_non_ascending_pages() {
        let r = WholeFileOcrRequest {
            kind: FileKind::Pdf,
            ..make_req(vec![3, 1, 2])
        };
        let err = validate(&r, &settings_with(Provider::Paddleocr)).unwrap_err();
        match err {
            AppError::Config(msg) => assert!(msg.contains("严格升序"), "{msg}"),
            other => panic!("expected Config, got {other:?}"),
        }
    }
}
