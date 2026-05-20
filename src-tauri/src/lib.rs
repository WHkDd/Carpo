mod commands;
mod config;
mod error;
mod events;
mod image;
mod jobs;
mod ocr;
mod pdf;
mod pdf_chunk;
mod secrets;
mod state;

use tauri::Manager;

#[tauri::command]
async fn ping() -> Result<&'static str, error::AppError> {
    Ok("pong")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
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
        )
        .invoke_handler(tauri::generate_handler![
            ping,
            commands::files::load_raster_image,
            commands::files::list_supported_extensions,
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
            commands::system::open_log_dir
        ])
        .setup(|app| {
            app.manage(state::AppState::new()?);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // Graceful shutdown: when the user requests app exit, fire every
        // active job's cancellation token. Provider polling loops, retry
        // backoffs, and the PdfWorker queue all watch the same token, so
        // this stops outstanding network calls instead of letting them
        // race the process teardown. Fire-and-forget — we don't `await`
        // job teardown so quit stays snappy.
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if let Some(state) = handle.try_state::<state::AppState>() {
                for entry in state.jobs.list() {
                    if let Ok(uuid) = uuid::Uuid::parse_str(&entry.job_id) {
                        state.jobs.cancel(uuid);
                    }
                }
            }
        }
    });
}
