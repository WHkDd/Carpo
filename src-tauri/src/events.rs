//! Tauri event channel constants, plus the bridge that forwards
//! `xcvt-core`'s transport-agnostic `EventBus` onto Tauri's native event
//! system. Mirror the `EVENTS` map in `src/lib/ipc-types.ts` — when a name
//! changes here it must change there too.

use tauri::{AppHandle, Emitter};
use xcvt_core::jobs::{EventBus, JobEventKind};

pub const JOB_PROGRESS: &str = "xcvt://job/progress";
pub const JOB_DONE: &str = "xcvt://job/done";
pub const JOB_ERROR: &str = "xcvt://job/error";

fn tauri_event_name(kind: JobEventKind) -> &'static str {
    match kind {
        JobEventKind::Progress => JOB_PROGRESS,
        JobEventKind::Done => JOB_DONE,
        JobEventKind::Error => JOB_ERROR,
    }
}

/// Spawns a background task forwarding every `EventBus` emission onto the
/// Tauri webview as a native event. `xcvt-core`'s job runners only know
/// about `state.events.emit(...)`; the web server backs it with an SSE
/// broadcast, and this is the desktop equivalent — same runner code, two
/// transports.
pub fn bridge(app: AppHandle, events: &EventBus) {
    let mut rx = events.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let _ = app.emit(tauri_event_name(event.kind), event.payload);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}
