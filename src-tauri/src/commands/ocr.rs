use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};
use uuid::Uuid;
use xcvt_core::{
    error::{AppError, AppResult},
    jobs::{
        grouped::{self, GroupedOcrRequest},
        whole_file::{self, WholeFileOcrRequest},
        JobKind, JobListEntry,
    },
    ocr,
    state::AppState,
};

#[derive(Debug, Serialize)]
pub struct JobStarted {
    pub job_id: String,
}

#[tauri::command]
pub async fn start_grouped_ocr(
    app: AppHandle,
    req: GroupedOcrRequest,
    state: State<'_, Arc<AppState>>,
) -> AppResult<JobStarted> {
    let settings = crate::config::load(&app)?;
    // Load the language before validation so configuration errors from this
    // entry point use the same catalog as the job that follows.
    grouped::validate(&req)?;
    let (id, token) = state.jobs.register(JobKind::GroupedOcr);
    grouped::spawn_with_settings(state.inner().clone(), req, id, token, settings);
    Ok(JobStarted {
        job_id: id.to_string(),
    })
}

#[tauri::command]
pub async fn start_whole_file_ocr(
    app: AppHandle,
    req: WholeFileOcrRequest,
    state: State<'_, Arc<AppState>>,
) -> AppResult<JobStarted> {
    // Validation depends on the active provider (per-(provider, kind)
    // page caps), so load settings once through the desktop store backend
    // and pass the same snapshot into the runner.
    let settings = crate::config::load(&app)?;
    whole_file::validate(&req, &settings)?;
    let (id, token) = state.jobs.register(JobKind::WholeFile);
    whole_file::spawn_with_settings(state.inner().clone(), req, id, token, settings);
    Ok(JobStarted {
        job_id: id.to_string(),
    })
}

/// Lists models for a provider. The dialog edits a draft locally; rather
/// than force a Save before the user can click 刷新, the command accepts an
/// optional `settings` override (with the draft state) and an optional
/// `secret` override (with a just-typed but not-yet-persisted API key). The
/// keychain is only consulted for the secret when the caller doesn't pass one
/// — that way an existing saved key works for an `openai` refresh without
/// the user re-typing.
#[tauri::command]
pub async fn list_provider_models(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    settings: Option<crate::config::NonSecretSettings>,
    secret: Option<String>,
) -> AppResult<Vec<String>> {
    let settings = match settings {
        Some(s) => s,
        None => crate::config::load(&app)?,
    };
    let secret = if let Some(s) = secret {
        Some(s)
    } else {
        let secret_key = grouped::secret_key_for_provider(settings.provider);
        state.secrets.get(secret_key).await?
    };
    ocr::list_models(&state.http, &settings, secret.as_deref()).await
}

fn parse_job_id(s: &str) -> AppResult<Uuid> {
    Uuid::parse_str(s).map_err(|e| AppError::Config(format!("invalid job_id: {e}")))
}

#[tauri::command]
pub async fn cancel_job(job_id: String, state: State<'_, Arc<AppState>>) -> AppResult<bool> {
    let id = parse_job_id(&job_id)?;
    Ok(state.jobs.cancel(id))
}

#[tauri::command]
pub async fn list_jobs(state: State<'_, Arc<AppState>>) -> AppResult<Vec<JobListEntry>> {
    Ok(state.jobs.list())
}
