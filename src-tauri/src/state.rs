use std::{sync::Arc, time::Duration};

use crate::{
    error::{AppError, AppResult},
    jobs::JobRegistry,
    pdf::PdfWorker,
};

/// Application-wide shared state. All fields are `Send + Sync` by their own
/// types, so `AppState` is naturally `Send + Sync` — no `unsafe impl` is
/// needed (or correct).
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
