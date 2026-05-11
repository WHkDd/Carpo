//! Tauri event channel constants. Mirror the `EVENTS` map in
//! `src/lib/ipc-types.ts` — when a name changes here it must change there too.

pub const JOB_PROGRESS: &str = "xcvt://job/progress";
pub const JOB_DONE: &str = "xcvt://job/done";
pub const JOB_ERROR: &str = "xcvt://job/error";
