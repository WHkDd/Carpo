//! Whole-file OCR job runner.
//!
//! One call per requested page — no block cropping, no article grouping.
//! Page bitmaps are fetched on demand via [`PageLoader`], so peak memory
//! is bounded by the loader's small LRU rather than `pages.len() ×
//! page_size`. Progress events: one at start, one before/after each page's
//! OCR. Final `JOB_DONE` carries `{page, text}` pairs.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::grouped::{encode_png_bytes, secret_key_for_provider, FileKind};
use super::page_loader::PageLoader;
use crate::config;
use crate::error::{AppError, AppResult};
use crate::events;
use crate::ocr::{self, OcrRequest};
use crate::secrets;
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
}

#[derive(Debug, Clone, Serialize)]
struct PageErrorPayload {
    page: u32,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct DoneEvent {
    job_id: String,
    results: Vec<PageResultPayload>,
    errors: Vec<PageErrorPayload>,
    cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
struct ErrorEvent {
    job_id: String,
    error: String,
}

pub fn spawn(app: AppHandle, req: WholeFileOcrRequest, job_id: Uuid, token: CancellationToken) {
    tokio::spawn(async move {
        let outcome = run(&app, req, job_id, token).await;
        if let Some(state) = app.try_state::<AppState>() {
            state.jobs.remove(job_id);
        }
        if let Err(e) = outcome {
            log::error!("whole-file ocr job {job_id} crashed: {e}");
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
    req: WholeFileOcrRequest,
    job_id: Uuid,
    token: CancellationToken,
) -> AppResult<()> {
    let settings = config::load(app)?;
    let secret_key = secret_key_for_provider(settings.provider);
    let secret = secrets::get(secret_key).await?;
    let total = req.pages.len() as u32;
    let job_id_str = job_id.to_string();
    // Backend-derived (see `OcrProfile::ocr_dpi`); request DTO field is
    // ignored.
    let ocr_dpi = settings.ocr_profile.ocr_dpi();

    // Lazy bitmap loader. With `OCR_CONCURRENCY = 3` and the LRU capacity in
    // `PageLoader`, peak memory stays at a handful of decoded pages instead
    // of the full requested range.
    let loader = Arc::new(PageLoader::new(
        app.clone(),
        req.kind,
        PathBuf::from(&req.path),
        ocr_dpi,
    ));
    let client = app.state::<AppState>().http.clone();

    let _ = app.emit(
        events::JOB_PROGRESS,
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

    let concurrency = ocr::concurrency_for(settings.provider);
    let outcomes: Vec<PageOutcome> = stream::iter(req.pages.clone().into_iter().enumerate())
        .map(|(idx, page)| {
            run_one_page(
                app.clone(),
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
            PageOutcome::Done { page, text } => results.push(PageResultPayload { page, text }),
            PageOutcome::Failed { page, message } => {
                errors.push(PageErrorPayload { page, message })
            }
            PageOutcome::Cancelled => cancelled = true,
        }
    }

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

#[allow(clippy::too_many_arguments)]
async fn run_one_page(
    app: AppHandle,
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
    let _ = app.emit(
        events::JOB_PROGRESS,
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

    let png_bytes = match encode_png_bytes(&bitmap) {
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
            png_bytes: &png_bytes,
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
            let _ = app.emit(
                events::JOB_PROGRESS,
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

pub fn validate(req: &WholeFileOcrRequest) -> AppResult<()> {
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
    // 500 pages × ~20s/page ≈ 3 hours of OCR even on a fast provider; past
    // this point the user is better served by splitting the file so cancel
    // / retry granularity matches a sane review cycle.
    if req.pages.len() > 500 {
        return Err(AppError::Config(
            "单次最多识别 500 页（建议拆分大文件以获得更短的反馈周期）".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(validate(&r).is_err());
    }

    #[test]
    fn validate_passes_basic() {
        let r = make_req(vec![1, 2, 3]);
        let r = WholeFileOcrRequest {
            kind: FileKind::Pdf,
            ..r
        };
        assert!(validate(&r).is_ok());
    }

    #[test]
    fn validate_rejects_page_zero() {
        let r = make_req(vec![0, 1]);
        assert!(validate(&r).is_err());
    }

    #[test]
    fn validate_rejects_duplicate_pages() {
        let r = make_req(vec![1, 2, 2]);
        let r = WholeFileOcrRequest {
            kind: FileKind::Pdf,
            ..r
        };
        assert!(validate(&r).is_err());
    }

    #[test]
    fn validate_rejects_non_first_image_page() {
        let r = make_req(vec![2]);
        assert!(validate(&r).is_err());
    }
}
