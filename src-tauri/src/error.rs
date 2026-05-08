use serde::Serialize;
use thiserror::Error;

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
