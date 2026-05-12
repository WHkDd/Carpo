//! Whole-file OCR job runner.
//!
//! One call per requested page — no block cropping, no article grouping.
//! Progress events: one after prerender, one before/after each page's OCR.
//! Final `JOB_DONE` carries `{page, text}` pairs.
//!
//! Phase 1 (sync): pre-render every requested page into Send-safe `DynamicImage`s.
//! Phase 2 (async): OCR loop with bounded concurrency (`OCR_CONCURRENCY`),
//! each page -> encode PNG -> `ocr::recognize_with_retry`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use image::DynamicImage;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::grouped::{encode_png_b64, secret_key_for_provider, FileKind};
use crate::config;
use crate::error::{AppError, AppResult};
use crate::events;
use crate::ocr::{self, OcrRequest};
use crate::pdf;
use crate::secrets;
use crate::state::AppState;

const OCR_CONCURRENCY: usize = 3;

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct WholeFileOcrRequest {
    pub file_id: String,
    pub path: String,
    pub kind: FileKind,
    pub pages: Vec<u32>,
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
    let secret = secrets::get(secret_key)?;
    let total = req.pages.len() as u32;
    let job_id_str = job_id.to_string();

    let page_cache = {
        let state = app.state::<AppState>();
        let pdfium = state.pdfium.clone();
        prerender_pages(&pdfium, &req)?
    };

    let client = app.state::<AppState>().http.clone();

    let _ = app.emit(
        events::JOB_PROGRESS,
        ProgressEvent {
            job_id: job_id_str.clone(),
            done: 0,
            total,
            label: format!("页面已就绪 · 共 {} 页待识别", total),
        },
    );

    let page_cache = Arc::new(page_cache);
    let settings = Arc::new(settings);
    let secret_arc: Arc<Option<String>> = Arc::new(secret);
    let done_counter = Arc::new(AtomicU32::new(0));

    let outcomes: Vec<PageOutcome> = stream::iter(req.pages.clone().into_iter().enumerate())
        .map(|(idx, page)| {
            run_one_page(
                app.clone(),
                client.clone(),
                token.clone(),
                job_id_str.clone(),
                total,
                Arc::clone(&page_cache),
                Arc::clone(&settings),
                Arc::clone(&secret_arc),
                Arc::clone(&done_counter),
                page,
                idx + 1,
            )
        })
        .buffer_unordered(OCR_CONCURRENCY)
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
    page_cache: Arc<HashMap<u32, Arc<DynamicImage>>>,
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

    let Some(bitmap) = page_cache.get(&page) else {
        return PageOutcome::Failed {
            page,
            message: format!("page {} 未预渲染 (内部错误)", page),
        };
    };

    let b64 = match encode_png_b64(bitmap) {
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
            png_b64: &b64,
            prompt: &prompt,
        },
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

fn prerender_pages(
    pdfium: &Arc<pdfium_render::prelude::Pdfium>,
    req: &WholeFileOcrRequest,
) -> AppResult<HashMap<u32, Arc<DynamicImage>>> {
    let mut cache = HashMap::new();
    for page in &req.pages {
        let bitmap = match req.kind {
            FileKind::Image => crate::image::load_from_disk(Path::new(&req.path))?,
            FileKind::Pdf => {
                let rendered =
                    pdf::render_page_with(pdfium, Path::new(&req.path), *page, req.ocr_dpi)?;
                image::load_from_memory(&rendered.png_bytes)
                    .map_err(|e| AppError::Image(format!("decode rendered page: {e}")))?
            }
        };
        cache.insert(*page, Arc::new(bitmap));
    }
    Ok(cache)
}

pub fn validate(req: &WholeFileOcrRequest) -> AppResult<()> {
    if req.path.is_empty() {
        return Err(AppError::Config("缺少文件路径".into()));
    }
    if req.pages.is_empty() {
        return Err(AppError::Config("没有可识别的页面".into()));
    }
    if req.ocr_dpi == 0 {
        return Err(AppError::Config("ocr_dpi 必须大于 0".into()));
    }
    // Prevent accidental huge ranges.
    if req.pages.len() > 1000 {
        return Err(AppError::Config("单次最多识别 1000 页".into()));
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
    fn validate_rejects_zero_ocr_dpi() {
        let mut r = make_req(vec![1]);
        r.ocr_dpi = 0;
        assert!(validate(&r).is_err());
    }

    #[test]
    fn validate_passes_basic() {
        let r = make_req(vec![1, 2, 3]);
        assert!(validate(&r).is_ok());
    }
}
