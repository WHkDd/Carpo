//! Desktop settings persistence. The `NonSecretSettings` type and its
//! defaults live in `xcvt-core::config` (shared with the web/Docker server);
//! this module only supplies the Tauri-specific storage backend
//! (`tauri-plugin-store`, which keeps settings in the OS app-data dir and
//! handles atomic writes for us) so existing desktop installs don't need a
//! storage-format migration.

use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

pub use xcvt_core::config::NonSecretSettings;
use xcvt_core::error::{AppError, AppResult};

const STORE_FILE: &str = "settings.json";
const STORE_KEY: &str = "settings";

pub fn load<R: Runtime>(app: &AppHandle<R>) -> AppResult<NonSecretSettings> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::Config(format!("store open: {e}")))?;
    let Some(raw) = store.get(STORE_KEY) else {
        return Ok(NonSecretSettings::default());
    };
    serde_json::from_value::<NonSecretSettings>(raw)
        .map_err(|e| AppError::Config(format!("settings parse: {e}")))
}

pub fn save<R: Runtime>(app: &AppHandle<R>, s: &NonSecretSettings) -> AppResult<()> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::Config(format!("store open: {e}")))?;
    let value =
        serde_json::to_value(s).map_err(|e| AppError::Config(format!("settings encode: {e}")))?;
    store.set(STORE_KEY, value);
    store
        .save()
        .map_err(|e| AppError::Config(format!("store save: {e}")))
}
