use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use xcvt_core::{
    error::{AppError, AppResult},
    image::{encode_rgba_png, load_from_disk, supported_extensions},
    pdf::{clamp_preview_dimensions, encode_preview_jpeg},
};

/// Subdirectory of the app cache dir that holds PNGs materialized from the
/// system clipboard. Everything in here is ours and nothing else writes to
/// it — that is what makes [`clear_clipboard_imports`] safe.
const CLIPBOARD_IMPORT_DIR: &str = "clipboard-imports";
const CLIPBOARD_CONTENT_UNAVAILABLE: &str =
    "The clipboard contents were not available in the requested format or the clipboard is empty.";

/// Loads a raster image from disk and returns the preview-grade encode for
/// the canvas. Wire format matches `render_page`: width/height prefix +
/// JPEG bytes (see [`encode_preview_jpeg`]). The OCR pipeline reloads the
/// original file directly through `image::open`, so any alpha channel in the
/// source is preserved for OCR even though the preview drops it.
///
/// The reported width/height are the source's *native* dimensions even when
/// the encoded bitmap was clamped — block rects for images live in native
/// pixel coordinates (`grouped::page_scale` returns 1.0 for `FileKind::Image`),
/// so the canvas stretches the clamped bitmap back rather than moving the
/// coordinate space out from under saved blocks.
#[tauri::command]
pub async fn load_raster_image(path: String) -> AppResult<Response> {
    let img = tokio::task::spawn_blocking(move || load_from_disk(&PathBuf::from(path)))
        .await
        .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;
    let width = img.width();
    let height = img.height();
    let bytes =
        tokio::task::spawn_blocking(move || encode_preview_jpeg(clamp_preview_dimensions(img)))
            .await
            .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;

    let mut out = Vec::with_capacity(8 + bytes.len());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&bytes);
    Ok(Response::new(out))
}

#[tauri::command]
pub async fn list_supported_extensions() -> Vec<&'static str> {
    supported_extensions().to_vec()
}

#[derive(Debug, Serialize)]
pub struct ClipboardImageImport {
    pub path: String,
    pub name: String,
}

/// Materializes the system clipboard's image (if any) as a real PNG file and
/// returns its path, or `None` when the clipboard holds no image.
///
/// The file has to exist on disk: everything downstream — the preview
/// decode, and more importantly the OCR pipeline — reads `FileEntry.path`
/// again rather than reusing the bitmap the canvas already has. A blob URL or
/// a base64 round-trip would give us a preview that OCR then can't reproduce.
///
/// ## Why there is no `clipboard-manager:allow-read-image` capability
///
/// The read happens *here*, in Rust, through `ClipboardExt`. Capabilities gate
/// what the **frontend** may invoke over IPC; Rust-side plugin calls do not go
/// through that check. So `src-tauri/capabilities/default.json` deliberately
/// carries only `clipboard-manager:allow-write-text`, and pasting images works
/// anyway. Do not "fix" the apparent gap by granting the frontend
/// `allow-read-image` — that would let any script in the webview read the
/// user's clipboard directly, which is exactly what routing through this
/// command avoids.
#[tauri::command]
pub async fn import_clipboard_image(app: AppHandle) -> AppResult<Option<ClipboardImageImport>> {
    let dir = clipboard_import_dir(&app)?;

    let handle = app.clone();
    let image = tokio::task::spawn_blocking(move || {
        handle
            .clipboard()
            .read_image()
            .map(|image| image.to_owned())
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))?;

    // arboard reports an empty/text-only clipboard as ContentNotAvailable,
    // which the Tauri plugin currently preserves only as this stable message.
    // Silence that expected case; a poisoned lock, platform API failure, or
    // plugin initialization error is genuine and must reach the UI and log.
    let image = match image {
        Ok(image) => image,
        Err(error) if is_clipboard_content_unavailable(&error) => return Ok(None),
        Err(error) => return Err(AppError::Internal(format!("read clipboard image: {error}"))),
    };

    let width = image.width();
    let height = image.height();
    let rgba = image.rgba().to_vec();

    let png = tokio::task::spawn_blocking(move || encode_rgba_png(width, height, &rgba))
        .await
        .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;

    let name = format!(
        "clipboard-{}-{}.png",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        uuid::Uuid::new_v4().simple()
    );
    let target = dir.join(&name);

    write_atomic(&target, &png)?;

    Ok(Some(ClipboardImageImport {
        path: target.to_string_lossy().into_owned(),
        name,
    }))
}

fn clipboard_import_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Internal(format!("cache dir: {e}")))?
        .join(CLIPBOARD_IMPORT_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Internal(format!("create {}: {e}", dir.display())))?;
    Ok(dir)
}

fn is_clipboard_content_unavailable(error: &tauri_plugin_clipboard_manager::Error) -> bool {
    matches!(
        error,
        tauri_plugin_clipboard_manager::Error::Clipboard(message)
            if message == CLIPBOARD_CONTENT_UNAVAILABLE
    )
}

/// Writes to a sibling temp file and renames into place. The queue watches
/// nothing, but the import that follows this call reads the path immediately,
/// and a partially flushed PNG would surface as a corrupt-image error rather
/// than as the transient state it actually is.
fn write_atomic(target: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = target.with_extension("png.part");
    std::fs::write(&tmp, bytes)
        .map_err(|e| AppError::Internal(format!("write {}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::Internal(format!("rename into {}: {e}", target.display()))
    })
}

/// Empties the clipboard-import cache on launch.
///
/// Scoped to `<app cache dir>/clipboard-imports` and to the files Xcvt itself
/// writes there. It never walks the cache dir itself and never touches a
/// user-chosen directory — the pasted PNG lives in a cache dir precisely so
/// that deleting it is always safe.
pub fn clear_clipboard_imports(app: &AppHandle) {
    let Ok(cache) = app.path().app_cache_dir() else {
        return;
    };
    let dir = cache.join(CLIPBOARD_IMPORT_DIR);
    if !dir.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && is_clipboard_import_name(&path) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Matches the names produced by `import_clipboard_image` (and the `.part`
/// temp files a crash mid-write could leave behind).
fn is_clipboard_import_name(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
        n.starts_with("clipboard-") && (n.ends_with(".png") || n.ends_with(".part"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_leaves_no_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("clipboard-1-abc.png");
        write_atomic(&target, b"payload").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"payload");
        assert!(!target.with_extension("png.part").exists());
    }

    #[test]
    fn cleanup_matcher_is_scoped_to_our_own_names() {
        assert!(is_clipboard_import_name(Path::new("/c/clipboard-1-a.png")));
        assert!(is_clipboard_import_name(Path::new(
            "/c/clipboard-1-a.png.part"
        )));
        // Anything a user or another component could plausibly have put in
        // the same directory must survive a launch.
        assert!(!is_clipboard_import_name(Path::new("/c/scan.png")));
        assert!(!is_clipboard_import_name(Path::new("/c/notes.txt")));
        assert!(!is_clipboard_import_name(Path::new(
            "/c/my-clipboard-1.png"
        )));
    }

    #[test]
    fn only_content_unavailable_is_a_silent_clipboard_miss() {
        let empty = tauri_plugin_clipboard_manager::Error::Clipboard(
            CLIPBOARD_CONTENT_UNAVAILABLE.to_owned(),
        );
        let failure = tauri_plugin_clipboard_manager::Error::Clipboard(
            "clipboard service disconnected".to_owned(),
        );
        assert!(is_clipboard_content_unavailable(&empty));
        assert!(!is_clipboard_content_unavailable(&failure));
    }
}
