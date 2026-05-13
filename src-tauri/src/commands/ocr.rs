use serde::Serialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    jobs::{grouped::GroupedOcrRequest, whole_file::WholeFileOcrRequest, JobKind},
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
    state: State<'_, AppState>,
) -> AppResult<JobStarted> {
    crate::jobs::grouped::validate(&req)?;
    let (id, token) = state.jobs.register(JobKind::GroupedOcr);
    crate::jobs::grouped::spawn(app, req, id, token);
    Ok(JobStarted {
        job_id: id.to_string(),
    })
}

#[tauri::command]
pub async fn start_whole_file_ocr(
    app: AppHandle,
    req: WholeFileOcrRequest,
    state: State<'_, AppState>,
) -> AppResult<JobStarted> {
    crate::jobs::whole_file::validate(&req)?;
    let (id, token) = state.jobs.register(JobKind::WholeFile);
    crate::jobs::whole_file::spawn(app, req, id, token);
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
    state: State<'_, AppState>,
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
        let secret_key = match settings.provider {
            crate::config::Provider::Paddleocr => crate::secrets::SecretKey::PaddleToken,
            crate::config::Provider::Openai => crate::secrets::SecretKey::OpenaiKey,
            crate::config::Provider::Openrouter => crate::secrets::SecretKey::OpenrouterKey,
            crate::config::Provider::OpenaiCompatible => {
                crate::secrets::SecretKey::OpenaiCompatibleKey
            }
        };
        crate::secrets::get(secret_key).await?
    };
    crate::ocr::list_models(&state.http, &settings, secret.as_deref()).await
}

fn parse_job_id(s: &str) -> AppResult<Uuid> {
    Uuid::parse_str(s).map_err(|e| AppError::Config(format!("invalid job_id: {e}")))
}

#[tauri::command]
pub async fn cancel_job(job_id: String, state: State<'_, AppState>) -> AppResult<bool> {
    let id = parse_job_id(&job_id)?;
    Ok(state.jobs.cancel(id))
}

#[tauri::command]
pub async fn list_jobs(state: State<'_, AppState>) -> AppResult<Vec<crate::jobs::JobListEntry>> {
    Ok(state.jobs.list())
}
