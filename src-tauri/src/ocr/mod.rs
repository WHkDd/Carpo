//! OCR provider dispatch + retry wrapper.
//!
//! Each provider lives in its own module (`paddle`, `openai`, ...) and exposes
//! a plain `async fn recognize` plus optionally a `list_models`. This module
//! routes a single `recognize` call to the active provider based on settings,
//! and `recognize_with_retry` wraps that call with the documented backoff
//! schedule [0, 2, 5]s on transient errors.
//!
//! Mirrors `OCREngine.MAX_RETRIES = 3` / `RETRY_BACKOFF_SECONDS = (0, 2, 5)`
//! in `newspaper_ocr.py:316-318`. Deviation from plan.md T5.3: we use enum
//! dispatch + free per-provider fns instead of a `dyn OcrProvider` trait. The
//! per-file layout, retry semantics, and wiremock coverage are preserved; only
//! the abstraction shape differs.

use std::time::Duration;

use crate::config::{NonSecretSettings, Provider};
use crate::error::{AppError, AppResult};

pub mod openai;
pub mod paddle;

pub const MAX_RETRIES: u32 = 3;
pub const BACKOFF_SECS: [u64; 3] = [0, 2, 5];

#[derive(Debug, Clone, Copy)]
pub struct OcrRequest<'a> {
    pub png_b64: &'a str,
    pub prompt: &'a str,
}

/// Routes a single OCR call to the configured provider. `secret` is the API
/// key / token loaded from the keychain by the caller; callers should refuse
/// to call this with `None` when the provider requires credentials.
pub async fn recognize(
    client: &reqwest::Client,
    settings: &NonSecretSettings,
    secret: Option<&str>,
    req: OcrRequest<'_>,
) -> AppResult<String> {
    match settings.provider {
        Provider::Paddleocr => {
            let token = secret.unwrap_or_default();
            paddle::recognize(client, &settings.paddle_url, token, req.png_b64).await
        }
        Provider::Openai => {
            let key = secret.unwrap_or_default();
            openai::recognize(
                client,
                openai::OFFICIAL_BASE_URL,
                key,
                &settings.openai_model,
                req.prompt,
                req.png_b64,
                "openai",
            )
            .await
        }
        Provider::Openrouter | Provider::OpenaiCompatible => Err(AppError::Internal(format!(
            "provider {:?} not wired in this commit (see T5.3 continuation)",
            settings.provider
        ))),
    }
}

/// Runs `recognize` up to `MAX_RETRIES` times, sleeping `BACKOFF_SECS[attempt]`
/// between attempts. Only retries errors flagged `retryable` (HTTP 429 / 5xx /
/// timeout / connect failures). Non-retryable errors propagate immediately.
pub async fn recognize_with_retry(
    client: &reqwest::Client,
    settings: &NonSecretSettings,
    secret: Option<&str>,
    req: OcrRequest<'_>,
) -> AppResult<String> {
    let mut last_err: Option<AppError> = None;
    for attempt in 0..MAX_RETRIES {
        let delay = BACKOFF_SECS[attempt as usize];
        if delay > 0 {
            tokio::time::sleep(Duration::from_secs(delay)).await;
        }
        match recognize(client, settings, secret, req).await {
            Ok(v) => return Ok(v),
            Err(e) if e.is_retryable() => {
                last_err = Some(e);
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::Internal("retry loop exhausted".into())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{NonSecretSettings, OcrProfile, Provider};
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn openai_settings(base_url_for_test: &str) -> NonSecretSettings {
        // The official base URL is hardcoded for the Openai provider, so for
        // retry-loop tests we drive paddle (whose URL we can point at a mock).
        let _ = base_url_for_test;
        NonSecretSettings {
            provider: Provider::Openai,
            ocr_profile: OcrProfile::Standard,
            ocr_prompt: "p".into(),
            paddle_url: String::new(),
            openai_model: "gpt-4o".into(),
            openrouter_model: String::new(),
            openai_compatible_base_url: String::new(),
            openai_compatible_model: String::new(),
        }
    }

    #[tokio::test]
    async fn retry_recovers_after_transient_5xx() {
        let server = MockServer::start().await;
        // First call: 503. Second call: 200.
        Mock::given(method("POST"))
            .and(path("/ocr"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/ocr"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "result": { "layoutParsingResults": [
                    { "markdown": { "text": "recovered" } }
                ]}
            })))
            .mount(&server)
            .await;

        let settings = NonSecretSettings {
            provider: Provider::Paddleocr,
            ocr_profile: OcrProfile::Standard,
            ocr_prompt: "p".into(),
            paddle_url: format!("{}/ocr", server.uri()),
            openai_model: String::new(),
            openrouter_model: String::new(),
            openai_compatible_base_url: String::new(),
            openai_compatible_model: String::new(),
        };
        let req = OcrRequest {
            png_b64: "x",
            prompt: "p",
        };
        let out = recognize_with_retry(&reqwest::Client::new(), &settings, Some("tk"), req)
            .await
            .unwrap();
        assert_eq!(out, "recovered");
    }

    #[tokio::test]
    async fn retry_gives_up_after_max_attempts() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ocr"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let settings = NonSecretSettings {
            provider: Provider::Paddleocr,
            ocr_profile: OcrProfile::Standard,
            ocr_prompt: "p".into(),
            paddle_url: format!("{}/ocr", server.uri()),
            openai_model: String::new(),
            openrouter_model: String::new(),
            openai_compatible_base_url: String::new(),
            openai_compatible_model: String::new(),
        };
        let req = OcrRequest {
            png_b64: "x",
            prompt: "p",
        };
        let err = recognize_with_retry(&reqwest::Client::new(), &settings, Some("tk"), req)
            .await
            .unwrap_err();
        assert!(err.is_retryable());
    }

    #[tokio::test]
    async fn unimplemented_provider_returns_internal_error() {
        let mut settings = openai_settings("ignored");
        settings.provider = Provider::Openrouter;
        let req = OcrRequest {
            png_b64: "x",
            prompt: "p",
        };
        let err = recognize(&reqwest::Client::new(), &settings, Some("k"), req)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Internal(_)));
    }
}
