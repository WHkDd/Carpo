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

pub fn get(key: SecretKey) -> AppResult<Option<String>> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::from(e)),
    }
}

pub fn set(key: SecretKey, value: &str) -> AppResult<()> {
    entry(key)?.set_password(value).map_err(AppError::from)
}

pub fn delete(key: SecretKey) -> AppResult<()> {
    match entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::from(e)),
    }
}
