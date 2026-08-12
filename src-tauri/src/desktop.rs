use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use carpo_core::image::supported_extensions;

pub const OPEN_PATHS_AVAILABLE: &str = "carpo://desktop/open-paths-available";
pub const MENU_OPEN_FILES: &str = "carpo://desktop/menu-open-files";
pub const MENU_IMPORT_PADDLE_JSON: &str = "carpo://desktop/menu-import-paddle-json";
pub const MENU_SETTINGS: &str = "carpo://desktop/menu-settings";
pub const NOTIFICATION_OPEN_FILE: &str = "carpo://desktop/notification-open-file";

#[derive(Default)]
pub struct DesktopState {
    pending_open_paths: Mutex<Vec<String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationOpenPayload {
    file_id: String,
}

fn has_supported_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            supported_extensions()
                .iter()
                .any(|supported| ext.eq_ignore_ascii_case(supported))
        })
}

fn collect_open_paths(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    let mut seen = HashSet::new();
    args.into_iter()
        .filter(|arg| !arg.starts_with('-'))
        .filter_map(|arg| {
            let path = PathBuf::from(arg);
            let absolute = if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            };
            if !absolute.is_file() || !has_supported_extension(&absolute) {
                return None;
            }
            let normalized = absolute
                .canonicalize()
                .unwrap_or(absolute)
                .to_string_lossy()
                .into_owned();
            seen.insert(normalized.clone()).then_some(normalized)
        })
        .collect()
}

pub fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn queue_open_paths<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let state = app.state::<DesktopState>();
    let mut pending = state.pending_open_paths.lock().unwrap();
    for path in paths {
        if !pending.contains(&path) {
            pending.push(path);
        }
    }
    drop(pending);
    let _ = app.emit(OPEN_PATHS_AVAILABLE, ());
}

pub fn queue_cli_open_paths<R: Runtime>(app: &AppHandle<R>, args: Vec<String>, cwd: &str) {
    let paths = collect_open_paths(args, Path::new(cwd));
    queue_open_paths(app, paths);
}

#[cfg(target_os = "macos")]
pub fn queue_open_urls<R: Runtime>(app: &AppHandle<R>, urls: Vec<tauri::Url>) {
    let paths = urls
        .into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter(|path| path.is_file() && has_supported_extension(path))
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    queue_open_paths(app, paths);
}

#[tauri::command]
pub fn take_pending_open_paths(state: State<'_, DesktopState>) -> Vec<String> {
    std::mem::take(&mut *state.pending_open_paths.lock().unwrap())
}

#[tauri::command]
pub async fn notify_ocr_result(
    app: AppHandle,
    file_id: String,
    title: String,
    body: String,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let focused = window.is_focused().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        if focused && !minimized {
            return Ok(());
        }
    }

    #[cfg(target_os = "macos")]
    {
        let identifier = if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            app.config().identifier.as_str()
        };
        let _ = notify_rust::set_application(identifier);
    }

    // The Tauri notification plugin owns permission handling, but its desktop
    // send command drops the native response handle. Keep that handle here so
    // Clicking the banner can focus Carpo and route back to the job's file.
    let mut notification = notify_rust::Notification::new();
    notification
        .appname("Carpo")
        .summary(&title)
        .body(&body)
        .auto_icon();
    let handle = notification.show().map_err(|error| error.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let app_for_click = app.clone();
        let _ = handle.wait_for_response(move |response: &notify_rust::NotificationResponse| {
            if !response.is_default_action() {
                return;
            }
            focus_main_window(&app_for_click);
            let _ = app_for_click.emit(NOTIFICATION_OPEN_FILE, NotificationOpenPayload { file_id });
        });
    });
    Ok(())
}

fn cancel_active_jobs<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<std::sync::Arc<carpo_core::state::AppState>>() {
        for entry in state.jobs.list() {
            if let Ok(uuid) = uuid::Uuid::parse_str(&entry.job_id) {
                state.jobs.cancel(uuid);
            }
        }
    }
}

pub fn handle_run_event(app: &AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { .. } => cancel_active_jobs(app),
        #[cfg(target_os = "macos")]
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            api.prevent_close();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            queue_open_urls(app, urls);
            focus_main_window(app);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => focus_main_window(app),
        _ => {}
    }
}

#[cfg(target_os = "macos")]
pub fn native_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};

    let menu = Menu::default(app)?;
    let top_level = menu.items()?;

    if let Some(MenuItemKind::Submenu(app_menu)) = top_level.first() {
        app_menu.set_text("Carpo")?;
        for (index, item) in app_menu.items()?.into_iter().enumerate() {
            if let MenuItemKind::Predefined(item) = item {
                match index {
                    0 => item.set_text("About Carpo")?,
                    4 => item.set_text("Hide Carpo")?,
                    7 => item.set_text("Quit Carpo")?,
                    _ => {}
                }
            }
        }
        let settings =
        MenuItem::with_id(app, "carpo-settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
        app_menu.insert(&settings, 1)?;
    }

    if let Some(MenuItemKind::Submenu(file_menu)) = top_level.get(1) {
        let open = MenuItem::with_id(app, "carpo-open-files", "Open…", true, Some("CmdOrCtrl+O"))?;
        let import_json = MenuItem::with_id(
            app,
            "carpo-import-paddle-json",
            "Import Paddle JSON…",
            true,
            None::<&str>,
        )?;
        let separator = PredefinedMenuItem::separator(app)?;
        file_menu.prepend_items(&[&open, &import_json, &separator])?;
    }

    Ok(menu)
}

#[cfg(target_os = "macos")]
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let event_name = match event.id().as_ref() {
        "carpo-open-files" => Some(MENU_OPEN_FILES),
        "carpo-import-paddle-json" => Some(MENU_IMPORT_PADDLE_JSON),
        "carpo-settings" => Some(MENU_SETTINGS),
        _ => None,
    };
    if let Some(event_name) = event_name {
        let _ = app.emit(event_name, ());
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeSet, path::Path};

    use super::collect_open_paths;
    use carpo_core::image::supported_extensions;

    #[test]
    fn bundle_file_associations_match_the_import_allowlist() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let configured = config["bundle"]["fileAssociations"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|entry| entry["ext"].as_array().unwrap())
            .map(|ext| ext.as_str().unwrap())
            .collect::<BTreeSet<_>>();
        let supported = supported_extensions()
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        assert_eq!(configured, supported);
    }

    #[test]
    fn cli_paths_ignore_flags_missing_files_and_unsupported_extensions() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("scan.PDF"), b"not parsed here").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"ignored").unwrap();
        let paths = collect_open_paths(
            vec![
                "--flag".to_string(),
                "scan.PDF".to_string(),
                "notes.txt".to_string(),
                "missing.png".to_string(),
            ],
            Path::new(dir.path()),
        );
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("scan.PDF"));
    }
}
