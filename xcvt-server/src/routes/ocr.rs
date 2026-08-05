use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use xcvt_core::{
    config::{self, NonSecretSettings},
    error::AppError,
    jobs::{
        grouped::{ArticleOcrPlan, FileKind, GroupedOcrRequest},
        whole_file::WholeFileOcrRequest,
        JobEvent, JobKind, JobListEntry,
    },
    ocr,
    secrets::SecretProvider,
};

use crate::{app_state::ServerState, error::ServerResult};

#[derive(Debug, Serialize)]
pub struct JobStarted {
    pub job_id: String,
}

#[derive(Debug, Deserialize)]
pub struct WebGroupedOcrRequest {
    pub file_id: Uuid,
    pub preview_dpi: u32,
    #[serde(default)]
    pub ocr_dpi: u32,
    pub articles: Vec<ArticleOcrPlan>,
    #[serde(default)]
    pub newspaper_name: String,
    #[serde(default)]
    pub newspaper_date: String,
}

#[derive(Debug, Deserialize)]
pub struct WebWholeFileOcrRequest {
    pub file_id: Uuid,
    pub pages: Vec<u32>,
    #[serde(default)]
    pub ocr_dpi: u32,
    #[serde(default)]
    pub newspaper_name: String,
    #[serde(default)]
    pub newspaper_date: String,
}

#[derive(Debug, Deserialize)]
pub struct ListModelsRequest {
    pub settings: Option<NonSecretSettings>,
    pub secret: Option<String>,
}

pub async fn start_grouped_ocr(
    State(state): State<ServerState>,
    Json(req): Json<WebGroupedOcrRequest>,
) -> ServerResult<Json<JobStarted>> {
    let record = file_record(&state, req.file_id)?;
    let settings = config::load(&state.data_dir)?;
    let req = GroupedOcrRequest {
        file_id: req.file_id.to_string(),
        path: record.path.display().to_string(),
        kind: record.kind,
        preview_dpi: req.preview_dpi,
        ocr_dpi: req.ocr_dpi,
        articles: req.articles,
        newspaper_name: req.newspaper_name,
        newspaper_date: req.newspaper_date,
    };
    xcvt_core::jobs::grouped::validate(&req)?;
    let (id, token) = state.core.jobs.register(JobKind::GroupedOcr);
    xcvt_core::jobs::grouped::spawn_with_settings(state.core.clone(), req, id, token, settings);
    Ok(Json(JobStarted {
        job_id: id.to_string(),
    }))
}

pub async fn start_whole_file_ocr(
    State(state): State<ServerState>,
    Json(req): Json<WebWholeFileOcrRequest>,
) -> ServerResult<Json<JobStarted>> {
    let record = file_record(&state, req.file_id)?;
    let req = WholeFileOcrRequest {
        file_id: req.file_id.to_string(),
        path: record.path.display().to_string(),
        kind: record.kind,
        pages: req.pages,
        ocr_dpi: req.ocr_dpi,
        newspaper_name: req.newspaper_name,
        newspaper_date: req.newspaper_date,
    };
    let settings = config::load(&state.data_dir)?;
    xcvt_core::jobs::whole_file::validate(&req, &settings)?;
    let (id, token) = state.core.jobs.register(JobKind::WholeFile);
    xcvt_core::jobs::whole_file::spawn(state.core.clone(), req, id, token);
    Ok(Json(JobStarted {
        job_id: id.to_string(),
    }))
}

pub async fn list_provider_models(
    State(state): State<ServerState>,
    Json(req): Json<ListModelsRequest>,
) -> ServerResult<Json<Vec<String>>> {
    let settings = req.settings.unwrap_or(config::load(&state.data_dir)?);
    let secret = match req.secret {
        Some(value) if !value.is_empty() => Some(value),
        _ => {
            state
                .secrets
                .get(xcvt_core::jobs::grouped::secret_key_for_provider(
                    settings.provider,
                ))
                .await?
        }
    };
    let models = ocr::list_models(&state.core.http, &settings, secret.as_deref()).await?;
    Ok(Json(models))
}

pub async fn cancel_job(State(state): State<ServerState>, Path(job_id): Path<Uuid>) -> Json<bool> {
    Json(state.core.jobs.cancel(job_id))
}

pub async fn list_jobs(State(state): State<ServerState>) -> Json<Vec<JobListEntry>> {
    Json(state.core.jobs.list())
}

/// Recovers a job's terminal (`done` / `error`) event after the fact —
/// backs the web client's reconnect/refresh reconciliation, since a
/// `broadcast`-channel SSE stream never replays to a receiver that
/// (re)subscribes after the event already fired. 404 once the job is
/// neither running nor within the event cache's retention window (see
/// `EventBus::recent`), which the client treats as "result unrecoverable".
pub async fn job_result(
    State(state): State<ServerState>,
    Path(job_id): Path<Uuid>,
) -> Result<Json<JobEvent>, StatusCode> {
    state
        .core
        .events
        .recent(&job_id.to_string())
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

fn file_record(state: &ServerState, file_id: Uuid) -> ServerResult<crate::app_state::FileRecord> {
    let record = state
        .file(file_id)
        .ok_or_else(|| AppError::FileNotFound(file_id.to_string()))?;
    if !matches!(record.kind, FileKind::Image | FileKind::Pdf) {
        return Err(AppError::Config("unsupported file kind".into()).into());
    }
    Ok(record)
}
