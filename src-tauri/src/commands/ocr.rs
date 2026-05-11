use serde::Serialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    jobs::{grouped::GroupedOcrRequest, JobKind},
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
pub async fn list_provider_models(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Vec<String>> {
    let settings = crate::config::load(&app)?;
    let secret_key = match settings.provider {
        crate::config::Provider::Paddleocr => crate::secrets::SecretKey::PaddleToken,
        crate::config::Provider::Openai => crate::secrets::SecretKey::OpenaiKey,
        crate::config::Provider::Openrouter => crate::secrets::SecretKey::OpenrouterKey,
        crate::config::Provider::OpenaiCompatible => {
            crate::secrets::SecretKey::OpenaiCompatibleKey
        }
    };
    let secret = crate::secrets::get(secret_key)?;
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
