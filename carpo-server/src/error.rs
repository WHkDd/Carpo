use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use carpo_core::AppError;

pub type ServerResult<T> = Result<T, ServerError>;

#[derive(Debug)]
pub struct ServerError(pub AppError);

impl From<AppError> for ServerError {
    fn from(value: AppError) -> Self {
        Self(value)
    }
}

impl From<std::io::Error> for ServerError {
    fn from(value: std::io::Error) -> Self {
        Self(AppError::Internal(value.to_string()))
    }
}

impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
        let status = match self.0 {
            AppError::Config(_) => StatusCode::BAD_REQUEST,
            AppError::FileNotFound(_) => StatusCode::NOT_FOUND,
            AppError::Pdf(_) | AppError::Image(_) => StatusCode::BAD_REQUEST,
            AppError::Ocr { .. } | AppError::Network(_) => StatusCode::BAD_GATEWAY,
            AppError::Cancelled(_) => StatusCode::CONFLICT,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(self.0)).into_response()
    }
}
