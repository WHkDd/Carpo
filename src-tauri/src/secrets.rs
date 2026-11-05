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

use std::sync::Mutex;

use keyring::Entry;

use carpo_core::error::{AppError, AppResult};
pub use carpo_core::secrets::SecretKey;
use carpo_core::secrets::{SecretFuture, SecretProvider};

const SERVICE: &str = "carpo.key";
const LEGACY_SERVICE: &str = "local.kai.carpo";

// Keep migrations atomic with respect to reads, replacements and deletions,
// including when an awaiting task is cancelled while the OS call continues.
static KEYCHAIN_LOCK: Mutex<()> = Mutex::new(());

// `AppError` and `keyring::Error` are both foreign to this crate now that
// `AppError` lives in `carpo-core` — the orphan rule forbids a `From` impl
// bridging them here, so map explicitly at each call site instead.
fn keyring_err(e: keyring::Error) -> AppError {
    AppError::Config(format!("keyring: {e}"))
}

fn entry(service: &str, key: SecretKey) -> AppResult<Entry> {
    Entry::new(service, key.as_str()).map_err(keyring_err)
}

fn delete_if_present(entry: &Entry) -> AppResult<()> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(keyring_err(e)),
    }
}

fn read_secret(current: &Entry, legacy: &Entry) -> AppResult<Option<String>> {
    match current.get_password() {
        Ok(value) => return Ok(Some(value)),
        Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(keyring_err(e)),
    }

    // Missing legacy entries do not create a credential. Fresh installations
    // only ever write under SERVICE; existing installations migrate on demand.
    let value = match legacy.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(keyring_err(e)),
    };

    // Never remove the old credential before its replacement is persisted.
    current.set_password(&value).map_err(keyring_err)?;
    delete_if_present(legacy)?;
    Ok(Some(value))
}

async fn run_blocking<T, F>(f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let _guard = KEYCHAIN_LOCK
            .lock()
            .map_err(|_| AppError::Internal("keyring lock poisoned".into()))?;
        f()
    })
    .await
    .map_err(|e| AppError::Internal(format!("keyring blocking join: {e}")))?
}

#[derive(Debug, Default)]
pub struct KeychainSecretProvider;

impl KeychainSecretProvider {
    pub async fn set(&self, key: SecretKey, value: String) -> AppResult<()> {
        run_blocking(move || {
            entry(SERVICE, key)?
                .set_password(&value)
                .map_err(keyring_err)?;
            delete_if_present(&entry(LEGACY_SERVICE, key)?)
        })
        .await
    }

    pub async fn delete(&self, key: SecretKey) -> AppResult<()> {
        run_blocking(move || {
            // If legacy deletion fails, leave the current credential intact
            // rather than letting the next read resurrect the old value.
            delete_if_present(&entry(LEGACY_SERVICE, key)?)?;
            delete_if_present(&entry(SERVICE, key)?)
        })
        .await
    }
}

impl SecretProvider for KeychainSecretProvider {
    fn get<'a>(&'a self, key: SecretKey) -> SecretFuture<'a> {
        Box::pin(run_blocking(move || {
            read_secret(&entry(SERVICE, key)?, &entry(LEGACY_SERVICE, key)?)
        }))
    }
}

#[cfg(test)]
mod tests {
    use keyring::{credential::CredentialApi, mock::MockCredential};

    use super::*;

    fn mock_entry() -> Entry {
        Entry::new_with_credential(Box::new(MockCredential::default()))
    }

    fn deny_next_access(entry: &Entry) {
        entry
            .get_credential()
            .downcast_ref::<MockCredential>()
            .unwrap()
            .set_error(keyring::Error::Invalid(
                "test".into(),
                "access denied".into(),
            ));
    }

    #[test]
    fn fresh_install_has_no_credentials_and_creates_no_legacy_entry() {
        let current = mock_entry();
        let legacy = mock_entry();

        assert_eq!(read_secret(&current, &legacy).unwrap(), None);
        current.set_password("new-token").unwrap();
        assert_eq!(
            read_secret(&current, &legacy).unwrap().as_deref(),
            Some("new-token")
        );
        assert!(matches!(
            legacy.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }

    #[test]
    fn current_credential_takes_precedence_without_accessing_legacy() {
        let current = mock_entry();
        let legacy = mock_entry();
        current.set_password("new-token").unwrap();
        legacy.set_password("old-token").unwrap();
        deny_next_access(&legacy);

        assert_eq!(
            read_secret(&current, &legacy).unwrap().as_deref(),
            Some("new-token")
        );
        // The injected error remains pending because legacy was not accessed.
        assert!(legacy.get_password().is_err());
        assert_eq!(legacy.get_password().unwrap(), "old-token");
    }

    #[test]
    fn legacy_credential_is_moved_and_subsequent_reads_only_use_current() {
        let current = mock_entry();
        let legacy = mock_entry();
        legacy.set_password("old-token").unwrap();

        assert_eq!(
            read_secret(&current, &legacy).unwrap().as_deref(),
            Some("old-token")
        );
        assert_eq!(current.get_password().unwrap(), "old-token");
        assert!(matches!(
            legacy.get_password(),
            Err(keyring::Error::NoEntry)
        ));

        deny_next_access(&legacy);
        assert_eq!(
            read_secret(&current, &legacy).unwrap().as_deref(),
            Some("old-token")
        );
        assert!(legacy.get_password().is_err());
    }

    #[test]
    fn current_access_failure_does_not_fall_back_to_legacy() {
        let current = mock_entry();
        let legacy = mock_entry();
        legacy.set_password("old-token").unwrap();
        deny_next_access(&current);
        deny_next_access(&legacy);

        assert!(read_secret(&current, &legacy).is_err());
        assert!(legacy.get_password().is_err());
        assert_eq!(legacy.get_password().unwrap(), "old-token");
    }

    #[test]
    fn denied_migration_preserves_legacy_credential() {
        let current = mock_entry();
        let legacy = mock_entry();
        legacy.set_password("old-token").unwrap();
        deny_next_access(&legacy);

        assert!(read_secret(&current, &legacy).is_err());
        assert!(matches!(
            current.get_password(),
            Err(keyring::Error::NoEntry)
        ));
        assert_eq!(legacy.get_password().unwrap(), "old-token");
    }

    #[derive(Default)]
    struct FailingCredential {
        inner: MockCredential,
        fail_write: bool,
        fail_delete: bool,
    }

    impl CredentialApi for FailingCredential {
        fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
            if self.fail_write {
                return Err(keyring::Error::Invalid(
                    "test".into(),
                    "write failed".into(),
                ));
            }
            self.inner.set_secret(secret)
        }

        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            self.inner.get_secret()
        }

        fn delete_credential(&self) -> keyring::Result<()> {
            if self.fail_delete {
                return Err(keyring::Error::Invalid(
                    "test".into(),
                    "delete failed".into(),
                ));
            }
            self.inner.delete_credential()
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    #[test]
    fn failed_migration_write_preserves_legacy_credential() {
        let current = Entry::new_with_credential(Box::new(FailingCredential {
            fail_write: true,
            ..Default::default()
        }));
        let legacy = mock_entry();
        legacy.set_password("old-token").unwrap();

        assert!(read_secret(&current, &legacy).is_err());
        assert_eq!(legacy.get_password().unwrap(), "old-token");
        assert!(matches!(
            current.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }

    #[test]
    fn failed_legacy_cleanup_keeps_current_authoritative() {
        let current = mock_entry();
        let legacy = Entry::new_with_credential(Box::new(FailingCredential {
            fail_delete: true,
            ..Default::default()
        }));
        legacy.set_password("old-token").unwrap();

        assert!(read_secret(&current, &legacy).is_err());
        assert_eq!(current.get_password().unwrap(), "old-token");
        assert_eq!(legacy.get_password().unwrap(), "old-token");
        legacy.set_password("stale-token").unwrap();
        assert_eq!(
            read_secret(&current, &legacy).unwrap().as_deref(),
            Some("old-token")
        );
    }

    #[test]
    fn deleted_migrated_credential_is_not_restored() {
        let current = mock_entry();
        let legacy = mock_entry();
        legacy.set_password("old-token").unwrap();
        read_secret(&current, &legacy).unwrap();

        delete_if_present(&legacy).unwrap();
        delete_if_present(&current).unwrap();
        assert_eq!(read_secret(&current, &legacy).unwrap(), None);
    }

    #[test]
    fn deleting_missing_credentials_is_idempotent() {
        let entry = mock_entry();
        delete_if_present(&entry).unwrap();
        entry.set_password("token").unwrap();
        delete_if_present(&entry).unwrap();
        delete_if_present(&entry).unwrap();
    }
}
