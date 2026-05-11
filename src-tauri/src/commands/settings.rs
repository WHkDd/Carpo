use tauri::{AppHandle, Runtime};

use crate::{
    config::{self, NonSecretSettings},
    error::AppResult,
    secrets::{self, SecretKey},
};

/// Returns whether a secret is present in the keychain. Never returns the raw
/// value — the frontend only needs to know whether the field is configured.
#[tauri::command]
pub async fn get_secret(key: SecretKey) -> AppResult<bool> {
    Ok(secrets::get(key)?.is_some())
}

#[tauri::command]
pub async fn set_secret(key: SecretKey, value: String) -> AppResult<()> {
    secrets::set(key, &value)
}

#[tauri::command]
pub async fn delete_secret(key: SecretKey) -> AppResult<()> {
    secrets::delete(key)
}

#[tauri::command]
pub async fn get_settings<R: Runtime>(app: AppHandle<R>) -> AppResult<NonSecretSettings> {
    config::load(&app)
}

#[tauri::command]
pub async fn set_settings<R: Runtime>(
    app: AppHandle<R>,
    s: NonSecretSettings,
) -> AppResult<()> {
    config::save(&app, &s)
}

