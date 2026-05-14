//! Job registry + cancellation. Stored in `AppState` so commands can look
//! jobs up by id, signal cancellation, and the spawned tokio task can remove
//! itself when it finishes.
//!
//! Each job gets a UUID and a `CancellationToken` (from `tokio-util`). The
//! token is cloneable; the registry keeps one copy, the worker task gets
//! another. `cancel_job(id)` flips the token; the worker checks it between
//! work units and breaks out cleanly.

pub mod grouped;
pub mod page_loader;
pub mod whole_file;

use std::collections::HashMap;

use parking_lot::Mutex;
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    GroupedOcr,
    WholeFile,
}

#[derive(Debug)]
pub struct JobHandle {
    pub token: CancellationToken,
    pub kind: JobKind,
}

#[derive(Debug, Default)]
pub struct JobRegistry {
    by_id: Mutex<HashMap<Uuid, JobHandle>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobListEntry {
    pub job_id: String,
    pub kind: JobKind,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Allocates a fresh job id + cancellation token. Caller spawns the
    /// worker with the returned token clone; the registry keeps its own
    /// clone for `cancel`.
    pub fn register(&self, kind: JobKind) -> (Uuid, CancellationToken) {
        let token = CancellationToken::new();
        let id = Uuid::new_v4();
        self.by_id.lock().insert(
            id,
            JobHandle {
                token: token.clone(),
                kind,
            },
        );
        (id, token)
    }

    /// Cancels the named job. Returns `true` if the job existed, `false`
    /// otherwise. Always idempotent — calling twice on the same id won't
    /// panic, the second call is a no-op.
    pub fn cancel(&self, id: Uuid) -> bool {
        let guard = self.by_id.lock();
        if let Some(handle) = guard.get(&id) {
            handle.token.cancel();
            true
        } else {
            false
        }
    }

    /// Drops a job entry. Called by the worker task once it exits, regardless
    /// of success/failure/cancellation.
    pub fn remove(&self, id: Uuid) {
        self.by_id.lock().remove(&id);
    }

    pub fn list(&self) -> Vec<JobListEntry> {
        self.by_id
            .lock()
            .iter()
            .map(|(id, handle)| JobListEntry {
                job_id: id.to_string(),
                kind: handle.kind,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_then_cancel_marks_token_cancelled() {
        let reg = JobRegistry::new();
        let (id, token) = reg.register(JobKind::GroupedOcr);
        assert!(!token.is_cancelled());
        assert!(reg.cancel(id));
        assert!(token.is_cancelled());
    }

    #[test]
    fn cancel_unknown_id_returns_false() {
        let reg = JobRegistry::new();
        let other = Uuid::new_v4();
        assert!(!reg.cancel(other));
    }

    #[test]
    fn cancel_twice_is_idempotent() {
        let reg = JobRegistry::new();
        let (id, _t) = reg.register(JobKind::GroupedOcr);
        assert!(reg.cancel(id));
        assert!(reg.cancel(id)); // second call: still true (entry exists), token stays cancelled
    }

    #[test]
    fn remove_drops_entry() {
        let reg = JobRegistry::new();
        let (id, _t) = reg.register(JobKind::GroupedOcr);
        assert_eq!(reg.list().len(), 1);
        reg.remove(id);
        assert!(reg.list().is_empty());
        assert!(!reg.cancel(id));
    }

    #[test]
    fn list_returns_all_active_jobs() {
        let reg = JobRegistry::new();
        let (_a, _ta) = reg.register(JobKind::GroupedOcr);
        let (_b, _tb) = reg.register(JobKind::GroupedOcr);
        assert_eq!(reg.list().len(), 2);
    }
}
