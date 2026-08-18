use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use carpo_core::{
    config::{self, NonSecretSettings, Provider},
    error::AppError,
    jobs::{
        grouped::{ArticleOcrPlan, FileKind, GroupedOcrRequest},
        proofread::{ProofreadRequest, ProofreadUnit},
        whole_file::WholeFileOcrRequest,
        JobEvent, JobKind, JobListEntry,
    },
    ocr,
    secrets::SecretProvider,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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
    carpo_core::jobs::grouped::validate(&req)?;
    let (id, token) = state.core.jobs.try_register(JobKind::GroupedOcr)?;
    carpo_core::jobs::grouped::spawn_with_settings(state.core.clone(), req, id, token, settings);
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
    carpo_core::jobs::whole_file::validate(&req, &settings)?;
    let (id, token) = state.core.jobs.try_register(JobKind::WholeFile)?;
    // Hand the runner the same snapshot `validate` just approved. `spawn` takes
    // no settings and has the runner re-read the file, so a concurrent
    // `PUT /api/settings` could run the job under a configuration that was
    // never validated — the other two routes already pass their snapshot down.
    carpo_core::jobs::whole_file::spawn_with_settings(state.core.clone(), req, id, token, settings);
    Ok(Json(JobStarted {
        job_id: id.to_string(),
    }))
}

#[derive(Debug, Deserialize)]
pub struct WebProofreadRequest {
    pub file_id: Uuid,
    pub units: Vec<ProofreadUnit>,
    /// Settings snapshot the client confirmed — the same fields the desktop
    /// invoke carries. Validated and run verbatim (see
    /// `jobs::proofread::effective_settings`).
    #[serde(default)]
    pub provider: Option<Provider>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
}

pub async fn start_proofread(
    State(state): State<ServerState>,
    Json(req): Json<WebProofreadRequest>,
) -> ServerResult<Json<JobStarted>> {
    // The proofread text comes from the client, so this is a consistency check
    // rather than a security boundary: all three job routes now refuse a
    // `file_id` this server has no upload for.
    file_record(&state, req.file_id)?;
    let settings = config::load(&state.data_dir)?;
    let req = ProofreadRequest {
        file_id: req.file_id.to_string(),
        units: req.units,
        provider: req.provider,
        model: req.model,
        prompt: req.prompt,
    };
    carpo_core::jobs::proofread::validate(&req, &settings)?;
    let (id, token) = state.core.jobs.try_register(JobKind::Proofread)?;
    carpo_core::jobs::proofread::spawn_with_settings(state.core.clone(), req, id, token, settings);
    Ok(Json(JobStarted {
        job_id: id.to_string(),
    }))
}

/// Lists models for a provider, for the settings dialog's "refresh" button.
///
/// The settings dialog edits a draft locally, so the request may carry an
/// override for the provider settings and for the key. **The two travel
/// together**: a caller that supplies its own `secret` may also choose the
/// endpoint that key is sent to, but a caller that falls back to the key this
/// server has on disk gets the endpoint this server has on disk as well.
///
/// Without that pairing the endpoint is a key-read primitive: the stored key
/// is otherwise write-only (`/api/settings/key-status` returns booleans), and
/// a single unauthenticated POST naming `provider: openai_compatible` plus an
/// attacker-controlled `openai_compatible_base_url` would have this server
/// send its own `Authorization: Bearer …` to that host. `ocr::list_models`
/// additionally screens the resolved URL (see `ocr::base_url`), which is what
/// stops the on-disk value from being steered inward — but only deployment
/// authentication stops someone who can also `PUT /api/settings` first.
pub async fn list_provider_models(
    State(state): State<ServerState>,
    Json(req): Json<ListModelsRequest>,
) -> ServerResult<Json<Vec<String>>> {
    let (settings, secret) = match req.secret {
        Some(value) if !value.is_empty() => (
            match req.settings {
                Some(s) => s,
                None => config::load(&state.data_dir)?,
            },
            Some(value),
        ),
        _ => {
            let settings = config::load(&state.data_dir)?;
            let secret = state
                .secrets
                .get(carpo_core::jobs::grouped::secret_key_for_provider(
                    settings.provider,
                ))
                .await?;
            (settings, secret)
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
