//! Secret storage backed by the OS keychain (macOS Keychain / Windows
//! Credential Manager / Linux Secret Service).
//!
//! The synchronous `keyring` API can block the calling thread for tens to
//! hundreds of milliseconds — especially on macOS when the keychain is locked
//! and prompts the user for a password. All public functions therefore wrap
//! the call in `tokio::task::spawn_blocking` so they never wedge a tokio
//! worker thread.
//!
//! Implements [`carpo_core::secrets::SecretProvider`] so a single
//! `KeychainSecretProvider` instance can back both the job runners (via
//! `AppState::secrets`, `.get` only) and the settings commands (`set` /
//! `delete`, kept as inherent methods since they're outside the trait's
//! read-only contract that `carpo-server`'s file-backed `SecretsStore` also
//! implements).

use keyring::Entry;

use carpo_core::error::{AppError, AppResult};
pub use carpo_core::secrets::SecretKey;
use carpo_core::secrets::{SecretFuture, SecretProvider};

const SERVICE: &str = "local.kai.carpo";

// `AppError` and `keyring::Error` are both foreign to this crate now that
// `AppError` lives in `carpo-core` — the orphan rule forbids a `From` impl
// bridging them here, so map explicitly at each call site instead.
fn keyring_err(e: keyring::Error) -> AppError {
    AppError::Config(format!("keyring: {e}"))
}

fn entry(key: SecretKey) -> AppResult<Entry> {
    Entry::new(SERVICE, key.as_str()).map_err(keyring_err)
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

#[derive(Debug, Default)]
pub struct KeychainSecretProvider;

impl KeychainSecretProvider {
    pub async fn set(&self, key: SecretKey, value: String) -> AppResult<()> {
        run_blocking(move || entry(key)?.set_password(&value).map_err(keyring_err)).await
    }

    pub async fn delete(&self, key: SecretKey) -> AppResult<()> {
        run_blocking(move || match entry(key)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keyring_err(e)),
        })
        .await
    }
}

impl SecretProvider for KeychainSecretProvider {
    fn get<'a>(&'a self, key: SecretKey) -> SecretFuture<'a> {
        Box::pin(run_blocking(move || match entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keyring_err(e)),
        }))
    }
}
