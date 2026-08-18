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
pub mod proofread;
pub mod whole_file;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    GroupedOcr,
    WholeFile,
    Proofread,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobEventKind {
    Progress,
    Done,
    Error,
}

impl JobEventKind {
    pub fn as_sse_name(self) -> &'static str {
        match self {
            JobEventKind::Progress => "progress",
            JobEventKind::Done => "done",
            JobEventKind::Error => "error",
        }
    }
}

/// Machine-readable description of what a job is doing right now, emitted
/// alongside the human-readable `label` on every progress event. The UI
/// formats this in the language the user picked instead of parsing the
/// label's prose — see `ProgressStage` in `src/lib/ipc-types.ts`.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProgressStage {
    PreparingBlocks {
        total: u32,
    },
    PreparingPages {
        total: u32,
    },
    PreparingChunks {
        total: u32,
    },
    SubmittingDocument {
        total: u32,
    },
    ChunkSubmitting {
        chunk: u32,
        chunks: u32,
        pages: u32,
    },
    ChunkRunning {
        chunk: u32,
        chunks: u32,
        done: u32,
        total: u32,
    },
    DocumentRunning {
        done: u32,
        total: u32,
    },
    PageRunning {
        page: u32,
        total: u32,
    },
    PageDone {
        page: u32,
        total: u32,
    },
    BlockRunning {
        article_num: u32,
        index: u32,
        count: u32,
    },
    BlockDone {
        article_num: u32,
        index: u32,
        count: u32,
    },
    /// Proofread pass over one text unit (a page, or one article).
    ProofreadRunning {
        index: u32,
        count: u32,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct JobEvent {
    pub kind: JobEventKind,
    pub payload: Value,
}

/// How long a terminal (`Done` / `Error`) event stays fetchable via
/// [`EventBus::recent`] after it fires. Sized for "the web client's
/// EventSource reconnect happens within a few seconds to a couple of
/// minutes of the drop" — a `broadcast` channel only replays to receivers
/// that were already subscribed, so a page refresh or a reconnect gap loses
/// the event entirely unless something else remembers it.
const RECENT_RETENTION: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone)]
pub struct EventBus {
    tx: broadcast::Sender<JobEvent>,
    recent: std::sync::Arc<Mutex<HashMap<String, (Instant, JobEvent)>>>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self {
            tx,
            recent: std::sync::Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn emit<T: Serialize>(&self, kind: JobEventKind, payload: T) {
        match serde_json::to_value(payload) {
            Ok(payload) => {
                let event = JobEvent { kind, payload };
                if matches!(kind, JobEventKind::Done | JobEventKind::Error) {
                    if let Some(job_id) = event.payload.get("job_id").and_then(Value::as_str) {
                        let mut recent = self.recent.lock();
                        recent.retain(|_, (at, _)| at.elapsed() < RECENT_RETENTION);
                        recent.insert(job_id.to_string(), (Instant::now(), event.clone()));
                    }
                }
                let _ = self.tx.send(event);
            }
            Err(err) => {
                log::error!("job event serialization failed: {err}");
            }
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<JobEvent> {
        self.tx.subscribe()
    }

    /// Looks up the most recent terminal event for `job_id`, if it fired
    /// within [`RECENT_RETENTION`]. Backs the web client's reconnect
    /// reconciliation: a lost SSE `done` event can be recovered by polling
    /// this instead of leaving the UI stuck on "识别中" forever.
    pub fn recent(&self, job_id: &str) -> Option<JobEvent> {
        let recent = self.recent.lock();
        recent
            .get(job_id)
            .filter(|(at, _)| at.elapsed() < RECENT_RETENTION)
            .map(|(_, event)| event.clone())
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
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

/// How many jobs may be registered at once, process-wide.
///
/// This is an admission gate, not a scheduler: every job holds an entry from
/// `try_register` until its worker task exits, so the cap bounds how much work
/// (and, for the LLM-backed jobs, how much billable API traffic) a single
/// process can have in flight. The UI already refuses to start a second job
/// (see `selectJobStartBlocked`), so on the desktop this only ever fires as a
/// backstop; on `carpo-server`, where every browser tab has its own store and
/// the endpoints have no authentication, it is the only limit that exists.
/// Four leaves room for a queued retry or a second tab without letting an
/// unattended caller multiply jobs indefinitely.
pub const MAX_ACTIVE_JOBS: usize = 4;

impl JobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Allocates a fresh job id + cancellation token, or refuses with
    /// [`AppError::Busy`] when [`MAX_ACTIVE_JOBS`] are already registered.
    /// Caller spawns the worker with the returned token clone; the registry
    /// keeps its own clone for `cancel`.
    ///
    /// The capacity check and the insert happen under **one** lock acquisition
    /// on purpose: checking `len()` and inserting as two steps is itself a race
    /// that lets N concurrent callers all see room and all get in.
    pub fn try_register(&self, kind: JobKind) -> AppResult<(Uuid, CancellationToken)> {
        let token = CancellationToken::new();
        let id = Uuid::new_v4();
        let mut guard = self.by_id.lock();
        if guard.len() >= MAX_ACTIVE_JOBS {
            return Err(AppError::Busy(crate::trf!(
                "同时进行的任务已达上限（{} 个），请等待当前任务完成后再试。",
                "Too many jobs running at once (limit {}). Wait for one to finish and try again.",
                MAX_ACTIVE_JOBS
            )));
        }
        guard.insert(
            id,
            JobHandle {
                token: token.clone(),
                kind,
            },
        );
        Ok((id, token))
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
        let (id, token) = reg.try_register(JobKind::GroupedOcr).unwrap();
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
        let (id, _t) = reg.try_register(JobKind::GroupedOcr).unwrap();
        assert!(reg.cancel(id));
        assert!(reg.cancel(id)); // second call: still true (entry exists), token stays cancelled
    }

    #[test]
    fn remove_drops_entry() {
        let reg = JobRegistry::new();
        let (id, _t) = reg.try_register(JobKind::GroupedOcr).unwrap();
        assert_eq!(reg.list().len(), 1);
        reg.remove(id);
        assert!(reg.list().is_empty());
        assert!(!reg.cancel(id));
    }

    #[test]
    fn list_returns_all_active_jobs() {
        let reg = JobRegistry::new();
        let (_a, _ta) = reg.try_register(JobKind::GroupedOcr).unwrap();
        let (_b, _tb) = reg.try_register(JobKind::GroupedOcr).unwrap();
        assert_eq!(reg.list().len(), 2);
    }

    #[test]
    fn try_register_refuses_once_the_cap_is_reached() {
        let reg = JobRegistry::new();
        let held: Vec<_> = (0..MAX_ACTIVE_JOBS)
            .map(|_| reg.try_register(JobKind::Proofread).unwrap())
            .collect();
        assert_eq!(held.len(), MAX_ACTIVE_JOBS);
        match reg.try_register(JobKind::Proofread) {
            Err(AppError::Busy(_)) => {}
            other => panic!("expected Busy at capacity, got {other:?}"),
        }
        assert_eq!(reg.list().len(), MAX_ACTIVE_JOBS);
    }

    #[test]
    fn removing_a_job_frees_a_slot() {
        let reg = JobRegistry::new();
        let held: Vec<_> = (0..MAX_ACTIVE_JOBS)
            .map(|_| reg.try_register(JobKind::WholeFile).unwrap())
            .collect();
        assert!(reg.try_register(JobKind::WholeFile).is_err());
        reg.remove(held[0].0);
        // A worker that finished must hand its slot back, or the process is
        // permanently wedged after MAX_ACTIVE_JOBS lifetime jobs.
        let (id, _t) = reg.try_register(JobKind::WholeFile).unwrap();
        assert_ne!(id, held[0].0);
    }
}
