use std::path::Path;

use tauri::Manager;

use crate::error::{AppError, AppResult};

/// Reveal the app log directory in the OS file manager.
///
/// Returns the resolved log directory path so the frontend can surface it on
/// failure (e.g. show the path in a toast if the spawn fails or the directory
/// is missing). The `tauri-plugin-log` plugin uses `app_log_dir()` as well, so
/// this command opens the exact location written by `TargetKind::LogDir`.
#[tauri::command]
pub async fn open_log_dir(app: tauri::AppHandle) -> AppResult<String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Internal(format!("resolve app_log_dir: {e}")))?;

    // The log plugin creates this lazily on first write. Create it ahead of
    // time so the first-run reveal works even before any log line has landed.
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Internal(format!("create log dir: {e}")))?;

    reveal_in_file_manager(&dir)?;
    Ok(dir.to_string_lossy().into_owned())
}

fn reveal_in_file_manager(path: &Path) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";

    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map_err(|e| AppError::Internal(format!("spawn {program}: {e}")))?;
    Ok(())
}
