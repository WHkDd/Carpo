use serde::Serialize;
use thiserror::Error;

#[allow(dead_code)]
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "data")]
pub enum AppError {
    #[error("config: {0}")]
    Config(String),

    #[error("file not found: {0}")]
    FileNotFound(String),

    #[error("pdf: {0}")]
    Pdf(String),

    #[error("image: {0}")]
    Image(String),

    #[error("ocr [{provider}]: {message}")]
    Ocr {
        provider: String,
        message: String,
        retryable: bool,
    },

    #[error("network: {0}")]
    Network(String),

    #[error("cancelled: {0}")]
    Cancelled(String),

    /// The request is well-formed but the process is at capacity right now —
    /// deliberately distinct from [`AppError::Config`], which means "this
    /// request will never be accepted". `carpo-server` maps it to HTTP 429.
    /// Kept out of [`AppError::is_retryable`] on purpose: that flag drives the
    /// automatic retry loop in `ocr::with_retry`, and auto-retrying a capacity
    /// refusal is just knocking harder on a closed door.
    #[error("busy: {0}")]
    Busy(String),

    #[error("internal: {0}")]
    Internal(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    #[allow(dead_code)] // wired into recognize_with_retry; the chain leaves cfg(test) only in T5.4.
    pub fn is_retryable(&self) -> bool {
        match self {
            AppError::Ocr { retryable, .. } => *retryable,
            AppError::Network(_) => true,
            _ => false,
        }
    }

    /// Strips the `retryable` flag off whichever variant carries it. Used by
    /// `recognize_with_retry` after the retry budget is exhausted: at that
    /// point the error is, by definition, not worth retrying again from the
    /// caller's perspective. Without this, the UI sees `is_retryable: true`
    /// and may double-retry on top of our internal loop.
    pub fn into_non_retryable(self) -> Self {
        match self {
            AppError::Ocr {
                provider, message, ..
            } => AppError::Ocr {
                provider,
                message,
                retryable: false,
            },
            AppError::Network(msg) => AppError::Ocr {
                provider: "network".into(),
                message: msg,
                retryable: false,
            },
            other => other,
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Internal(format!("json: {e}"))
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        // `Network` is treated as retryable everywhere; only true transport
        // failures (timeout, connect, redirect) belong there. Decode /
        // builder / body errors are protocol-level bugs that won't fix
        // themselves on a retry — surface them as `Internal` so the retry
        // wrapper doesn't pile on.
        if e.is_decode() || e.is_builder() || e.is_body() {
            AppError::Internal(format!("http: {e}"))
        } else {
            AppError::Network(e.to_string())
        }
    }
}
