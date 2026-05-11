mod commands;
mod config;
mod error;
mod events;
mod image;
mod jobs;
mod ocr;
mod pdf;
mod secrets;
mod state;

use tauri::Manager;

#[tauri::command]
async fn ping() -> Result<&'static str, error::AppError> {
    Ok("pong")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
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
            commands::ocr::list_provider_models,
            commands::ocr::cancel_job,
            commands::ocr::list_jobs
        ])
        .setup(|app| {
            app.manage(state::AppState::new()?);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
