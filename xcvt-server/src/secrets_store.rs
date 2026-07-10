use std::{collections::HashMap, fs, path::PathBuf};

use parking_lot::RwLock;
use xcvt_core::{
    error::{AppError, AppResult},
    secrets::{SecretFuture, SecretKey, SecretProvider},
};

#[derive(Debug)]
pub struct SecretsStore {
    path: PathBuf,
    values: RwLock<HashMap<SecretKey, String>>,
}

impl SecretsStore {
    pub fn open(path: PathBuf) -> AppResult<Self> {
        let values = if path.exists() {
            let raw = fs::read_to_string(&path)
                .map_err(|e| AppError::Config(format!("secrets read {}: {e}", path.display())))?;
            serde_json::from_str(&raw)
                .map_err(|e| AppError::Config(format!("secrets parse {}: {e}", path.display())))?
        } else {
            let mut seeded = HashMap::new();
            for key in [
                SecretKey::PaddleToken,
                SecretKey::OpenaiKey,
                SecretKey::OpenrouterKey,
                SecretKey::OpenaiCompatibleKey,
            ] {
                if let Ok(value) = std::env::var(key.env_var()) {
                    if !value.is_empty() {
                        seeded.insert(key, value);
                    }
                }
            }
            if !seeded.is_empty() {
                write_secret_file(&path, &seeded)?;
            }
            seeded
        };
        Ok(Self {
            path,
            values: RwLock::new(values),
        })
    }

    pub fn status(&self) -> HashMap<SecretKey, bool> {
        let values = self.values.read();
        [
            SecretKey::PaddleToken,
            SecretKey::OpenaiKey,
            SecretKey::OpenrouterKey,
            SecretKey::OpenaiCompatibleKey,
        ]
        .into_iter()
        .map(|key| (key, values.get(&key).is_some_and(|v| !v.is_empty())))
        .collect()
    }

    pub fn set(&self, key: SecretKey, value: String) -> AppResult<()> {
        let mut values = self.values.write();
        values.insert(key, value);
        write_secret_file(&self.path, &values)
    }

    pub fn delete(&self, key: SecretKey) -> AppResult<()> {
        let mut values = self.values.write();
        values.remove(&key);
        write_secret_file(&self.path, &values)
    }
}

impl SecretProvider for SecretsStore {
    fn get<'a>(&'a self, key: SecretKey) -> SecretFuture<'a> {
        Box::pin(async move { Ok(self.values.read().get(&key).cloned()) })
    }
}

fn write_secret_file(path: &PathBuf, values: &HashMap<SecretKey, String>) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::Config(format!("secrets dir {}: {e}", parent.display())))?;
    }
    let raw = serde_json::to_vec_pretty(values)
        .map_err(|e| AppError::Config(format!("secrets encode: {e}")))?;
    fs::write(path, raw)
        .map_err(|e| AppError::Config(format!("secrets save {}: {e}", path.display())))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| AppError::Config(format!("secrets chmod 0600 {}: {e}", path.display())))?;
    }
    Ok(())
}
