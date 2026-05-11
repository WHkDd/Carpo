//! OCR provider dispatch + retry wrapper.
//!
//! Each provider lives in its own module (`paddle`, `openai`, ...) and exposes
//! a plain `async fn recognize`. This module routes a single `recognize` call
//! to the active provider based on settings, and `recognize_with_retry` wraps
//! that call with the documented backoff schedule [0, 2, 5]s on transient
//! errors.
//!
//! Mirrors `OCREngine.MAX_RETRIES = 3` / `RETRY_BACKOFF_SECONDS = (0, 2, 5)`
//! in `newspaper_ocr.py:316-318`. Deviation from plan.md T5.3 wording: we use
//! enum dispatch + free per-provider fns instead of a `dyn OcrProvider` trait.
//! The per-file layout, retry semantics, and wiremock coverage are preserved;
//! only the abstraction shape differs.

use std::time::Duration;

use base64::Engine;

use crate::config::{NonSecretSettings, Provider};
use crate::error::{AppError, AppResult};

pub mod openai;
pub mod paddle;

pub const MAX_RETRIES: u32 = 3;
pub const BACKOFF_SECS: [u64; 3] = [0, 2, 5];

/// Default polling cadence for Paddle's async jobs endpoint. The Baidu sample
/// uses 5s; 2s is responsive without hammering the queue.
pub const PADDLE_POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Hard cap on how long a single OCR job is allowed to run before we give up.
/// Newspaper blocks are typically single-page; 5 min is generous.
pub const PADDLE_POLL_TIMEOUT: Duration = Duration::from_secs(300);

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
            let png_bytes = base64::engine::general_purpose::STANDARD
                .decode(req.png_b64.as_bytes())
                .map_err(|e| AppError::Image(format!("base64 decode: {e}")))?;
            paddle::recognize(
                client,
                &settings.paddle_url,
                token,
                &settings.paddle_model,
                png_bytes,
                PADDLE_POLL_INTERVAL,
                PADDLE_POLL_TIMEOUT,
            )
            .await
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
        Provider::Openrouter => {
            let key = secret.unwrap_or_default();
            openai::recognize(
                client,
                openai::OPENROUTER_BASE_URL,
                key,
                &settings.openrouter_model,
                req.prompt,
                req.png_b64,
                "openrouter",
            )
            .await
        }
        Provider::OpenaiCompatible => {
            if settings.openai_compatible_base_url.is_empty() {
                return Err(AppError::Config(
                    "OpenAI-Compatible：尚未配置 Base URL，请在设置中填入。".into(),
                ));
            }
            let key = secret.unwrap_or_default();
            openai::recognize(
                client,
                &settings.openai_compatible_base_url,
                key,
                &settings.openai_compatible_model,
                req.prompt,
                req.png_b64,
                "openai_compatible",
            )
            .await
        }
    }
}

/// Static fallback model list for PaddleOCR — the async jobs API has no
/// `/models` endpoint, so the settings dialog shows these four documented
/// values directly. Order matches Baidu's docs.
pub const PADDLE_MODELS: &[&str] = &[
    "PP-OCRv5",
    "PP-StructureV3",
    "PaddleOCR-VL",
    "PaddleOCR-VL-1.5",
];

/// Fetches the model list for the active provider. Backs the "刷新模型" button
/// in the settings dialog (T5.5). Paddle returns a static list because the
/// async jobs endpoint has no model-discovery surface; the other three hit
/// `{base_url}/models` with the user's key.
pub async fn list_models(
    client: &reqwest::Client,
    settings: &NonSecretSettings,
    secret: Option<&str>,
) -> AppResult<Vec<String>> {
    match settings.provider {
        Provider::Paddleocr => Ok(PADDLE_MODELS.iter().map(|s| (*s).to_string()).collect()),
        Provider::Openai => {
            openai::list_models(
                client,
                openai::OFFICIAL_BASE_URL,
                secret.unwrap_or_default(),
                "openai",
            )
            .await
        }
        Provider::Openrouter => {
            openai::list_models(
                client,
                openai::OPENROUTER_BASE_URL,
                secret.unwrap_or_default(),
                "openrouter",
            )
            .await
        }
        Provider::OpenaiCompatible => {
            if settings.openai_compatible_base_url.is_empty() {
                return Err(AppError::Config(
                    "OpenAI-Compatible：尚未配置 Base URL，请在设置中填入。".into(),
                ));
            }
            openai::list_models(
                client,
                &settings.openai_compatible_base_url,
                secret.unwrap_or_default(),
                "openai_compatible",
            )
            .await
        }
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
    use base64::Engine;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn paddle_settings(jobs_url: String) -> NonSecretSettings {
        NonSecretSettings {
            provider: Provider::Paddleocr,
            ocr_profile: OcrProfile::Standard,
            ocr_prompt: String::new(),
            paddle_url: jobs_url,
            paddle_model: "PaddleOCR-VL-1.5".into(),
            openai_model: String::new(),
            openrouter_model: String::new(),
            openai_compatible_base_url: String::new(),
            openai_compatible_model: String::new(),
        }
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[tokio::test]
    async fn retry_recovers_after_transient_5xx() {
        let server = MockServer::start().await;
        let base = server.uri();
        let json_url = format!("{base}/r.jsonl");

        // First submit attempt fails 503 (retryable); the retry wrapper sleeps
        // BACKOFF_SECS[1] = 2s then attempts again.
        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "jobId": "j" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v2/ocr/jobs/j"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "state": "done", "resultUrl": { "jsonUrl": json_url } }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/r.jsonl"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                json!({ "result": { "layoutParsingResults": [{ "markdown": { "text": "recovered" } }] } }).to_string(),
            ))
            .mount(&server)
            .await;

        let settings = paddle_settings(format!("{base}/api/v2/ocr/jobs"));
        let png = b64(b"x");
        let req = OcrRequest {
            png_b64: &png,
            prompt: "",
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
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let settings = paddle_settings(format!("{}/api/v2/ocr/jobs", server.uri()));
        let png = b64(b"x");
        let req = OcrRequest {
            png_b64: &png,
            prompt: "",
        };
        let err = recognize_with_retry(&reqwest::Client::new(), &settings, Some("tk"), req)
            .await
            .unwrap_err();
        assert!(err.is_retryable());
    }

    #[tokio::test]
    async fn unimplemented_provider_returns_internal_error() {
        // Sanity smoke: with empty base_url, the OpenAI-Compatible arm refuses
        // to dispatch and returns a Config error rather than panicking.
        let mut settings = paddle_settings(String::new());
        settings.provider = Provider::OpenaiCompatible;
        let png = b64(b"x");
        let req = OcrRequest {
            png_b64: &png,
            prompt: "p",
        };
        let err = recognize(&reqwest::Client::new(), &settings, Some("k"), req)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Config(_)));
    }

    #[tokio::test]
    async fn openai_compatible_routes_to_custom_base_url() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{ "message": { "content": "via custom" } }]
            })))
            .mount(&server)
            .await;

        let mut settings = paddle_settings(String::new());
        settings.provider = Provider::OpenaiCompatible;
        settings.openai_compatible_base_url = server.uri();
        settings.openai_compatible_model = "my-model".into();
        let png = b64(b"x");
        let req = OcrRequest {
            png_b64: &png,
            prompt: "p",
        };
        let out = recognize(&reqwest::Client::new(), &settings, Some("sk-x"), req)
            .await
            .unwrap();
        assert_eq!(out, "via custom");
    }

    #[tokio::test]
    async fn list_models_paddle_returns_static_catalogue() {
        let settings = paddle_settings(String::new());
        let models = list_models(&reqwest::Client::new(), &settings, None)
            .await
            .unwrap();
        assert_eq!(
            models,
            vec!["PP-OCRv5", "PP-StructureV3", "PaddleOCR-VL", "PaddleOCR-VL-1.5"]
        );
    }

    #[tokio::test]
    async fn list_models_openai_compatible_requires_base_url() {
        let mut settings = paddle_settings(String::new());
        settings.provider = Provider::OpenaiCompatible;
        let err = list_models(&reqwest::Client::new(), &settings, Some("sk"))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Config(_)));
    }
}
