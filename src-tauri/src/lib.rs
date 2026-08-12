mod commands;
mod config;
mod desktop;
mod events;
mod layout_pdf;
mod secrets;

use std::sync::Arc;

use tauri::Manager;
use tauri_plugin_window_state::StateFlags;
use carpo_core::{error::AppError, state::AppState};

use crate::secrets::KeychainSecretProvider;

#[tauri::command]
async fn ping() -> Result<&'static str, AppError> {
    Ok("pong")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(desktop::DesktopState::default())
        // Register this first: the plugin must claim the process-wide
        // single-instance endpoint before other setup work begins.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            desktop::queue_cli_open_paths(app, args, &cwd);
            desktop::focus_main_window(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Visibility, fullscreen, and decorations are product state,
                // not geometry. Restoring only these flags also avoids a
                // previously hidden window reopening invisibly.
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("app".to_string()),
                    }),
                ])
                .build(),
        );

    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(desktop::native_menu)
        .on_menu_event(desktop::handle_menu_event);

    let app = builder
        .invoke_handler(tauri::generate_handler![
            ping,
            desktop::take_pending_open_paths,
            desktop::notify_ocr_result,
            commands::files::load_raster_image,
            commands::files::list_supported_extensions,
            commands::files::import_clipboard_image,
            commands::render::get_pdf_info,
            commands::render::render_page,
            commands::settings::get_secret,
            commands::settings::set_secret,
            commands::settings::delete_secret,
            commands::settings::get_settings,
            commands::settings::set_settings,
            commands::ocr::start_grouped_ocr,
            commands::ocr::start_whole_file_ocr,
            commands::ocr::list_provider_models,
            commands::ocr::cancel_job,
            commands::ocr::list_jobs,
            commands::paddle_json::analyze_paddle_json,
            commands::paddle_json::import_paddle_json,
            commands::export::export_layout_pdf,
            commands::export::export_reading_markdown,
            commands::system::open_log_dir
        ])
        .setup(|app| {
            // PNGs materialized from clipboard pastes are single-session
            // scratch files. Reclaim last run's on launch — scoped to the
            // names we wrote, in our own cache dir.
            commands::files::clear_clipboard_imports(app.handle());
            let data_dir = app.path().app_data_dir()?;
            let secrets = Arc::new(KeychainSecretProvider);
            let core = Arc::new(AppState::new(data_dir, secrets.clone())?);
            events::bridge(app.handle().clone(), &core.events);
            app.manage(core);
            app.manage(secrets);

            // Finder/Explorer may launch the first instance with one or more
            // file arguments. Queue them for the frontend after its event
            // listeners are attached; later launches arrive through the
            // single-instance callback above.
            let args = std::env::args().skip(1).collect::<Vec<_>>();
            let cwd = std::env::current_dir()?.to_string_lossy().into_owned();
            desktop::queue_cli_open_paths(app.handle(), args, &cwd);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(desktop::handle_run_event);
}
