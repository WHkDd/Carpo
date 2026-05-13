//! OCR provider dispatch + retry wrapper.
//!
//! Each provider lives in its own module (`paddle`, `openai`, ...) and exposes
//! a plain `async fn recognize`. This module routes a single `recognize` call
//! to the active provider based on settings, and `recognize_with_retry` wraps
//! that call with the documented backoff schedule [0, 2, 5]s on transient
//! errors. A `CancellationToken` threads through every level so a user-driven
//! cancel reaches the provider polling loop without waiting for its own
//! timeout to elapse.

use std::time::Duration;

use tokio_util::sync::CancellationToken;

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

/// One OCR call's inputs. The image is owned by the caller as raw PNG bytes;
/// providers that need a different encoding (e.g. OpenAI's `data:` URL) do the
/// transformation themselves so retries don't repeatedly decode the same
/// base64 string.
#[derive(Debug, Clone, Copy)]
pub struct OcrRequest<'a> {
    pub png_bytes: &'a [u8],
    pub prompt: &'a str,
}

/// Routes a single OCR call to the configured provider. `secret` is the API
/// key / token loaded from the keychain by the caller; callers should refuse
/// to call this with `None` when the provider requires credentials. `cancel`
/// is consulted inside long-running provider loops (Paddle's poll).
pub async fn recognize(
    client: &reqwest::Client,
    settings: &NonSecretSettings,
    secret: Option<&str>,
    req: OcrRequest<'_>,
    cancel: &CancellationToken,
) -> AppResult<String> {
    match settings.provider {
        Provider::Paddleocr => {
            let token = secret.unwrap_or_default();
            paddle::recognize(
                client,
                &settings.paddle_url,
                token,
                &settings.paddle_model,
                req.png_bytes.to_vec(),
                PADDLE_POLL_INTERVAL,
                PADDLE_POLL_TIMEOUT,
                cancel,
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
                req.png_bytes,
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
                req.png_bytes,
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
                req.png_bytes,
                "openai_compatible",
            )
            .await
        }
    }
}

/// PaddleOCR models exposed by the settings dialog. Scoped to the VL family
/// because:
/// (a) Baidu documents a **different `optionalPayload` schema per model
///     class** — the three flags we currently send (`useDocOrientationClassify
///     / useDocUnwarping / useChartRecognition`) belong to PaddleOCR-VL; the
///     PP-OCRv5 / PP-StructureV3 payloads have different fields.
/// (b) The non-VL models are tuned for clean horizontal documents and perform
///     poorly on near-modern Chinese newspaper layouts (vertical / mixed /
///     irregular columns) — the only workload xcvt is built for.
/// If a future workflow needs a non-VL model, gate it behind a per-model
/// payload builder rather than just adding the id to this list.
pub const PADDLE_MODELS: &[&str] = &["PaddleOCR-VL", "PaddleOCR-VL-1.5"];

/// Fetches the model list for the active provider. Backs the "刷新模型" button
/// in the settings dialog. Paddle returns a static list because the
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
/// between attempts. Only retries errors flagged `retryable`. The backoff
/// sleep itself races against `cancel.cancelled()` so a cancel between
/// attempts doesn't burn the full delay.
pub async fn recognize_with_retry(
    client: &reqwest::Client,
    settings: &NonSecretSettings,
    secret: Option<&str>,
    req: OcrRequest<'_>,
    cancel: &CancellationToken,
) -> AppResult<String> {
    let mut last_err: Option<AppError> = None;
    for attempt in 0..MAX_RETRIES {
        let delay = BACKOFF_SECS[attempt as usize];
        if delay > 0 {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
                _ = cancel.cancelled() => {
                    return Err(AppError::Cancelled("retry backoff".into()));
                }
            }
        }
        match recognize(client, settings, secret, req, cancel).await {
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

    fn never_cancelled() -> CancellationToken {
        CancellationToken::new()
    }

    #[tokio::test]
    async fn retry_recovers_after_transient_5xx() {
        let server = MockServer::start().await;
        let base = server.uri();
        let json_url = format!("{base}/r.jsonl");

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
        let req = OcrRequest {
            png_bytes: b"x",
            prompt: "",
        };
        let cancel = never_cancelled();
        let out = recognize_with_retry(&reqwest::Client::new(), &settings, Some("tk"), req, &cancel)
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
        let req = OcrRequest {
            png_bytes: b"x",
            prompt: "",
        };
        let cancel = never_cancelled();
        let err = recognize_with_retry(&reqwest::Client::new(), &settings, Some("tk"), req, &cancel)
            .await
            .unwrap_err();
        assert!(err.is_retryable());
    }

    #[tokio::test]
    async fn unimplemented_provider_returns_config_error() {
        let mut settings = paddle_settings(String::new());
        settings.provider = Provider::OpenaiCompatible;
        let req = OcrRequest {
            png_bytes: b"x",
            prompt: "p",
        };
        let cancel = never_cancelled();
        let err = recognize(&reqwest::Client::new(), &settings, Some("k"), req, &cancel)
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
        let req = OcrRequest {
            png_bytes: b"x",
            prompt: "p",
        };
        let cancel = never_cancelled();
        let out = recognize(&reqwest::Client::new(), &settings, Some("sk-x"), req, &cancel)
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
        assert_eq!(models, vec!["PaddleOCR-VL", "PaddleOCR-VL-1.5"]);
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

    #[tokio::test]
    async fn cancel_aborts_backoff_sleep() {
        // Two 503s would normally make recognize_with_retry sleep 2s before
        // its second attempt. If we cancel during that sleep, the wrapper
        // must return AppError::Cancelled rather than waiting it out.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let settings = paddle_settings(format!("{}/api/v2/ocr/jobs", server.uri()));
        let req = OcrRequest {
            png_bytes: b"x",
            prompt: "",
        };
        let cancel = CancellationToken::new();
        let cancel_clone = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel_clone.cancel();
        });
        let started = std::time::Instant::now();
        let err = recognize_with_retry(&reqwest::Client::new(), &settings, Some("tk"), req, &cancel)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Cancelled(_)));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
