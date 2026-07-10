use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use xcvt_core::{
    config::{self, NonSecretSettings},
    error::AppError,
    secrets::SecretKey,
};

use crate::{app_state::ServerState, error::ServerResult};

pub async fn get_settings(
    State(state): State<ServerState>,
) -> ServerResult<Json<NonSecretSettings>> {
    Ok(Json(config::load(&state.data_dir)?))
}

pub async fn put_settings(
    State(state): State<ServerState>,
    Json(settings): Json<NonSecretSettings>,
) -> ServerResult<Json<NonSecretSettings>> {
    config::save(&state.data_dir, &settings)?;
    Ok(Json(settings))
}

#[derive(Debug, Serialize)]
pub struct KeyStatus {
    pub paddle_token: bool,
    pub openai_key: bool,
    pub openrouter_key: bool,
    pub openai_compatible_key: bool,
}

pub async fn key_status(State(state): State<ServerState>) -> Json<KeyStatus> {
    Json(status_response(state.secrets.status()))
}

#[derive(Debug, Deserialize)]
pub struct PutSecret {
    pub key: SecretKey,
    pub value: String,
}

pub async fn put_secret(
    State(state): State<ServerState>,
    Json(req): Json<PutSecret>,
) -> ServerResult<Json<KeyStatus>> {
    if req.value.is_empty() {
        return Err(AppError::Config("secret value cannot be empty".into()).into());
    }
    state.secrets.set(req.key, req.value)?;
    Ok(Json(status_response(state.secrets.status())))
}

pub async fn delete_secret(
    State(state): State<ServerState>,
    Path(key): Path<SecretKey>,
) -> ServerResult<Json<KeyStatus>> {
    state.secrets.delete(key)?;
    Ok(Json(status_response(state.secrets.status())))
}

fn status_response(status: HashMap<SecretKey, bool>) -> KeyStatus {
    KeyStatus {
        paddle_token: *status.get(&SecretKey::PaddleToken).unwrap_or(&false),
        openai_key: *status.get(&SecretKey::OpenaiKey).unwrap_or(&false),
        openrouter_key: *status.get(&SecretKey::OpenrouterKey).unwrap_or(&false),
        openai_compatible_key: *status
            .get(&SecretKey::OpenaiCompatibleKey)
            .unwrap_or(&false),
    }
}
