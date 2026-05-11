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
        AppError::Network(e.to_string())
    }
}
