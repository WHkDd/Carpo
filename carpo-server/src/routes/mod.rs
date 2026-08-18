mod files;
mod health;
mod jobs_sse;
mod ocr;
mod render;
mod settings;

use axum::{
    extract::DefaultBodyLimit,
    routing::{delete, get, post, put},
    Router,
};

use crate::app_state::ServerState;

const MAX_UPLOAD_BYTES: usize = 256 * 1024 * 1024;

/// Room for the text side of a proofread request on top of its images: the
/// bodies and the per-unit prompt are bounded by `MAX_BUDGET_CHARS` (400k
/// characters, at most ~1.2MB as UTF-8) plus JSON escaping and the keys.
const PROOFREAD_TEXT_HEADROOM_BYTES: usize = 8 * 1024 * 1024;

/// Body ceiling for `POST /api/ocr/proofread`. Since proofreading always
/// attaches the scans of the original, its bodies are megabytes, not the
/// kilobytes axum's 2MB default was sized for — that default would reject
/// every image-bearing request at the transport layer, before `validate`
/// could explain why.
///
/// Derived from the core cap rather than written as a literal so the two
/// cannot drift: this is deliberately the *looser* of the two, so an
/// over-limit request is refused by `validate` with a message naming the
/// actual limit (400) instead of by the transport as an opaque 413.
const MAX_PROOFREAD_BODY_BYTES: usize =
    carpo_core::jobs::proofread::MAX_IMAGES_TOTAL_B64_BYTES + PROOFREAD_TEXT_HEADROOM_BYTES;

pub fn router() -> Router<ServerState> {
    Router::new()
        .route("/healthz", get(health::healthz))
        .route(
            "/api/files",
            post(files::upload_file).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)),
        )
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
        .route(
            "/api/ocr/proofread",
            post(ocr::start_proofread).layer(DefaultBodyLimit::max(MAX_PROOFREAD_BODY_BYTES)),
        )
        .route("/api/ocr/models", post(ocr::list_provider_models))
        .route("/api/jobs", get(ocr::list_jobs))
        .route("/api/jobs/:job_id/cancel", post(ocr::cancel_job))
        .route("/api/jobs/:job_id/result", get(ocr::job_result))
        .route("/api/jobs/events", get(jobs_sse::events))
}
