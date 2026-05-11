use std::sync::Arc;

use pdfium_render::prelude::Pdfium;

use crate::{error::AppResult, jobs::JobRegistry, pdf::init_pdfium};

pub struct AppState {
    pub pdfium: Arc<Pdfium>,
    pub http: reqwest::Client,
    pub jobs: Arc<JobRegistry>,
}

// SAFETY: pdfium-render's `thread_safe` feature wraps dynamic bindings in a
// mutex, but the public `Pdfium` trait object does not carry Send/Sync
// auto-traits in 0.8.
unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

impl AppState {
    pub fn new() -> AppResult<Self> {
        Ok(Self {
            #[allow(clippy::arc_with_non_send_sync)]
            pdfium: Arc::new(init_pdfium()?),
            http: reqwest::Client::new(),
            jobs: Arc::new(JobRegistry::new()),
        })
    }

    pub fn pdfium(&self) -> &Pdfium {
        self.pdfium.as_ref()
    }
}
