use std::{future::Future, pin::Pin};

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

    pub fn env_var(self) -> &'static str {
        match self {
            SecretKey::PaddleToken => "XCVT_PADDLE_TOKEN",
            SecretKey::OpenaiKey => "XCVT_OPENAI_KEY",
            SecretKey::OpenrouterKey => "XCVT_OPENROUTER_KEY",
            SecretKey::OpenaiCompatibleKey => "XCVT_OPENAI_COMPATIBLE_KEY",
        }
    }
}

pub type SecretFuture<'a> = Pin<Box<dyn Future<Output = AppResult<Option<String>>> + Send + 'a>>;

pub trait SecretProvider: Send + Sync {
    fn get<'a>(&'a self, key: SecretKey) -> SecretFuture<'a>;
}

#[derive(Debug, Default)]
pub struct EmptySecretProvider;

impl SecretProvider for EmptySecretProvider {
    fn get<'a>(&'a self, _key: SecretKey) -> SecretFuture<'a> {
        Box::pin(async { Ok(None) })
    }
}
