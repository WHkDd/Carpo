mod files;
mod health;
mod jobs_sse;
mod ocr;
mod render;
mod settings;

use axum::{
    routing::{delete, get, post, put},
    Router,
};

use crate::app_state::ServerState;

pub fn router() -> Router<ServerState> {
    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/api/files", post(files::upload_file))
        .route("/api/files/:file_id", delete(files::delete_file))
        .route("/api/files/:file_id/pdf-info", get(render::pdf_info))
        .route("/api/files/:file_id/pages/:page", get(render::render_page))
        .route("/api/files/:file_id/raster", get(render::raster))
        .route(
            "/api/settings",
            get(settings::get_settings).put(settings::put_settings),
        )
        .route("/api/settings/key-status", get(settings::key_status))
        .route("/api/settings/secrets", put(settings::put_secret))
        .route(
            "/api/settings/secrets/:key",
            delete(settings::delete_secret),
        )
        .route("/api/ocr/grouped", post(ocr::start_grouped_ocr))
        .route("/api/ocr/whole-file", post(ocr::start_whole_file_ocr))
        .route("/api/ocr/models", post(ocr::list_provider_models))
        .route("/api/jobs", get(ocr::list_jobs))
        .route("/api/jobs/:job_id/cancel", post(ocr::cancel_job))
        .route("/api/jobs/events", get(jobs_sse::events))
}
