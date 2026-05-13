//! Secret storage backed by the OS keychain (macOS Keychain / Windows
//! Credential Manager / Linux Secret Service).
//!
//! The synchronous `keyring` API can block the calling thread for tens to
//! hundreds of milliseconds — especially on macOS when the keychain is locked
//! and prompts the user for a password. All public functions therefore wrap
//! the call in `tokio::task::spawn_blocking` so they never wedge a tokio
//! worker thread.

use keyring::Entry;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const SERVICE: &str = "local.kai.xcvt";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretKey {
    PaddleToken,
    OpenaiKey,
    OpenrouterKey,
    OpenaiCompatibleKey,
}

impl SecretKey {
    pub fn as_str(self) -> &'static str {
        match self {
            SecretKey::PaddleToken => "paddle_token",
            SecretKey::OpenaiKey => "openai_key",
            SecretKey::OpenrouterKey => "openrouter_key",
            SecretKey::OpenaiCompatibleKey => "openai_compatible_key",
        }
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Config(format!("keyring: {e}"))
    }
}

fn entry(key: SecretKey) -> AppResult<Entry> {
    Entry::new(SERVICE, key.as_str()).map_err(AppError::from)
}

async fn run_blocking<T, F>(f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("keyring blocking join: {e}")))?
}

pub async fn get(key: SecretKey) -> AppResult<Option<String>> {
    run_blocking(move || match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::from(e)),
    })
    .await
}

pub async fn set(key: SecretKey, value: String) -> AppResult<()> {
    run_blocking(move || entry(key)?.set_password(&value).map_err(AppError::from)).await
}

pub async fn delete(key: SecretKey) -> AppResult<()> {
    run_blocking(move || match entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::from(e)),
    })
    .await
}
