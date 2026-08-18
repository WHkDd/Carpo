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
            // Not 400: the request is fine, the server is full. A client that
            // sees 429 may retry later; one that sees 400 should not.
            AppError::Busy(_) => StatusCode::TOO_MANY_REQUESTS,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(self.0)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_maps_to_too_many_requests() {
        let response = ServerError(AppError::Busy("full".into())).into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[test]
    fn config_still_maps_to_bad_request() {
        // Guards the distinction the `Busy` variant exists for: an oversized
        // request and a full server must not answer with the same status.
        let response = ServerError(AppError::Config("nope".into())).into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
