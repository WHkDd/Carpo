use std::sync::Arc;

use carpo_core::{
    config::Theme,
    error::AppResult,
    secrets::{SecretKey, SecretProvider},
};
use tauri::{AppHandle, Manager, Runtime, State, Theme as NativeTheme};

use crate::{
    config::{self, NonSecretSettings},
    secrets::KeychainSecretProvider,
};

/// Maps the persisted theme preference onto the native appearance. `None`
/// lets the OS decide (tao then follows the system setting), while
/// `Light`/`Dark` pin the app-level `NSAppearance` — which also styles the
/// native menu bar, file dialogs and alerts, so the shell stays in step with
/// the WebView instead of remaining light-only. Also called from `setup` on
/// launch, before the window finishes its first layout.
pub fn native_theme(theme: Option<Theme>) -> Option<NativeTheme> {
    match theme {
        Some(Theme::Light) => Some(NativeTheme::Light),
        Some(Theme::Dark) => Some(NativeTheme::Dark),
        Some(Theme::System) | None => None,
    }
}

/// Applies the theme to every window. On macOS the theme is app-wide, so this
/// also retints the menu bar and native dialogs. Called on save so the switch
/// is immediate — the WebView toggles its own class at the same moment.
fn apply_native_theme<R: Runtime>(app: &AppHandle<R>, theme: Option<Theme>) {
    let native = native_theme(theme);
    for window in app.webview_windows().values() {
        let _ = window.set_theme(native);
    }
}

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
    config::save(&app, &s)?;
    // Keep the native shell (window chrome, menus, dialogs) on the same theme
    // the WebView just switched to. Fire after the persist so a failed theme
    // application never leaves settings.json behind the UI.
    apply_native_theme(&app, s.theme);
    Ok(())
}
