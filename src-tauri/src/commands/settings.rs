use std::sync::Arc;

use tauri::{AppHandle, Runtime, State};
use xcvt_core::{
    error::AppResult,
    secrets::{SecretKey, SecretProvider},
};

use crate::{
    config::{self, NonSecretSettings},
    secrets::KeychainSecretProvider,
};

/// Returns whether a secret is present in the keychain. Never returns the raw
/// value — the frontend only needs to know whether the field is configured.
#[tauri::command]
pub async fn get_secret(
    key: SecretKey,
    secrets: State<'_, Arc<KeychainSecretProvider>>,
) -> AppResult<bool> {
    Ok(secrets.get(key).await?.is_some())
}

#[tauri::command]
pub async fn set_secret(
    key: SecretKey,
    value: String,
    secrets: State<'_, Arc<KeychainSecretProvider>>,
) -> AppResult<()> {
    secrets.set(key, value).await
}

#[tauri::command]
pub async fn delete_secret(
    key: SecretKey,
    secrets: State<'_, Arc<KeychainSecretProvider>>,
) -> AppResult<()> {
    secrets.delete(key).await
}

#[tauri::command]
pub async fn get_settings<R: Runtime>(app: AppHandle<R>) -> AppResult<NonSecretSettings> {
    config::load(&app)
}

#[tauri::command]
pub async fn set_settings<R: Runtime>(app: AppHandle<R>, s: NonSecretSettings) -> AppResult<()> {
    config::save(&app, &s)
}
