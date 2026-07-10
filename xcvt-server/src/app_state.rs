use std::{collections::HashMap, path::PathBuf, sync::Arc};

use parking_lot::Mutex;
use uuid::Uuid;
use xcvt_core::{jobs::grouped::FileKind, state::AppState as CoreState};

use crate::secrets_store::SecretsStore;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct FileRecord {
    pub dir: PathBuf,
    pub path: PathBuf,
    pub name: String,
    pub ext: String,
    pub kind: FileKind,
}

#[derive(Clone)]
pub struct ServerState {
    pub core: Arc<CoreState>,
    pub data_dir: PathBuf,
    pub secrets: Arc<SecretsStore>,
    files: Arc<Mutex<HashMap<Uuid, FileRecord>>>,
}

impl ServerState {
    pub fn new(core: Arc<CoreState>, data_dir: PathBuf, secrets: Arc<SecretsStore>) -> Self {
        Self {
            core,
            data_dir,
            secrets,
            files: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn insert_file(&self, id: Uuid, record: FileRecord) {
        self.files.lock().insert(id, record);
    }

    pub fn file(&self, id: Uuid) -> Option<FileRecord> {
        self.files.lock().get(&id).cloned()
    }

    pub fn remove_file(&self, id: Uuid) -> Option<FileRecord> {
        self.files.lock().remove(&id)
    }
}
