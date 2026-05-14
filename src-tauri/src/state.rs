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
/// Two PDFium worker threads instead of one: a single shared worker would
/// queue OCR-grade prerenders behind preview renders (and vice versa), so
/// turning a multi-page OCR loose would freeze page-flip in the canvas. Each
/// worker owns its own `Pdfium` handle (cheap) and processes its own queue.
pub struct AppState {
    /// Preview rendering for the canvas. Sized for low-latency single-page
    /// requests driven by user interaction.
    pub pdf: PdfWorker,
    /// OCR-grade rendering used by the job runners. Throughput-oriented and
    /// can be saturated for minutes at a time without affecting `pdf`.
    pub pdf_ocr: PdfWorker,
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
            pdf_ocr: PdfWorker::spawn()?,
            http,
            jobs: Arc::new(JobRegistry::new()),
        })
    }
}
