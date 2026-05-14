use std::{sync::Arc, time::Duration};

use crate::{
    error::{AppError, AppResult},
    jobs::JobRegistry,
    pdf::PdfWorker,
};

/// Application-wide shared state. All fields are `Send + Sync` by their own
/// types, so `AppState` is naturally `Send + Sync` — no `unsafe impl` is
/// needed (or correct).
///
/// We deliberately run **one** `PdfWorker`, not two. PDFium's
/// `FPDF_InitLibrary` is process-global (see pdfium-render
/// `Pdfium::new`); calling it twice in the same process aborts on
/// startup. A previous attempt at preview/OCR worker separation crashed
/// the Tauri shell at launch. With `PageLoader`'s lazy + deduped loading
/// the OCR side only ever asks for 1–N pages (`N = OCR_CONCURRENCY`)
/// at once, so worst-case preview latency is bounded by a small handful
/// of render slots — acceptable until we add an in-worker priority lane.
pub struct AppState {
    pub pdf: PdfWorker,
    pub http: reqwest::Client,
    pub jobs: Arc<JobRegistry>,
}

impl AppState {
    pub fn new() -> AppResult<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(15))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .map_err(|e| AppError::Internal(format!("http client: {e}")))?;
        Ok(Self {
            pdf: PdfWorker::spawn()?,
            http,
            jobs: Arc::new(JobRegistry::new()),
        })
    }
}
