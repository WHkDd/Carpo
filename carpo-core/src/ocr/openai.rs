//! OpenAI (and OpenAI-compatible) chat completions vision recognition.
//!
//! Implements `POST {base_url}/chat/completions` with `Authorization: Bearer
//! {key}`, sending a single user message that pairs the page image (as a
//! `data:image/jpeg;base64,...` URL) with the OCR prompt. The same shape
//! powers OpenAI proper, OpenRouter, and any OpenAI-compatible endpoint —
//! the only thing that differs is `base_url`.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};

pub const OFFICIAL_BASE_URL: &str = "https://api.openai.com/v1";
pub const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";

const MAX_TOKENS: u32 = 4096;

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<Message<'a>>,
    max_tokens: u32,
}

#[derive(Serialize)]
struct Message<'a> {
    role: &'a str,
    content: MessageContent<'a>,
}

/// A message body is either a plain string or the multi-part array the vision
/// endpoints take. Untagged so both serialize to exactly the wire shape the
/// API documents — a bare `"content": "..."` for text, `"content": [...]` for
/// parts — with no discriminator of our own leaking into the request.
#[derive(Serialize)]
#[serde(untagged)]
enum MessageContent<'a> {
    Text(&'a str),
    Parts(Vec<ContentPart<'a>>),
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum ContentPart<'a> {
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrlData<'a> },
    #[serde(rename = "text")]
    Text { text: &'a str },
}

#[derive(Serialize)]
struct ImageUrlData<'a> {
    url: &'a str,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChoiceMessage,
    /// Absent from a few minimal providers; `length` / `max_tokens` means the
    /// model hit the token cap and the text is cut off mid-sentence.
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct ChoiceMessage {
    content: String,
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<Model>,
}

#[derive(Deserialize)]
struct Model {
    id: String,
}

/// Strips a trailing `/` so `{base}/chat/completions` always produces a clean URL.
fn join(base_url: &str, suffix: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    format!("{trimmed}{suffix}")
}

/// One chat-completions OCR call.
///
/// `cancel` races the in-flight request, not just the gaps around it. A single
/// whole-page image against a slow model can occupy the connection for most of
/// the client's 120s ceiling (see `AppState::new`), and without this the user's
/// Cancel would leave the job sitting in "cancelling" until the server replied
/// or the timeout elapsed. Dropping the `send()`/`json()` future is how reqwest
/// aborts a request, so returning out of `select!` is sufficient.
#[allow(clippy::too_many_arguments)]
pub async fn recognize(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    model: &str,
    prompt: &str,
    image_bytes: &[u8],
    provider_label: &str,
    cancel: &CancellationToken,
) -> AppResult<String> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(AppError::Cancelled(provider_label.into())),
        result = recognize_inner(client, base_url, key, model, prompt, image_bytes, provider_label) => result,
    }
}

#[allow(clippy::too_many_arguments)]
async fn recognize_inner(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    model: &str,
    prompt: &str,
    image_bytes: &[u8],
    provider_label: &str,
) -> AppResult<String> {
    if key.is_empty() {
        return Err(AppError::Config(crate::trf!(
            "{}：尚未配置 API Key，请在设置中填入。",
            "{}: no API key configured — set one in Settings.",
            provider_label
        )));
    }
    if model.is_empty() {
        return Err(AppError::Config(crate::trf!(
            "{}：尚未配置模型。",
            "{}: no model configured.",
            provider_label
        )));
    }

    let data_url = format!("data:image/jpeg;base64,{}", STANDARD.encode(image_bytes));
    let body = ChatRequest {
        model,
        messages: vec![Message {
            role: "user",
            content: MessageContent::Parts(vec![
                ContentPart::ImageUrl {
                    image_url: ImageUrlData { url: &data_url },
                },
                ContentPart::Text { text: prompt },
            ]),
        }],
        max_tokens: MAX_TOKENS,
    };

    post_chat(client, base_url, key, &body, provider_label).await
}

/// Sends one chat-completions body and reduces the response to its text.
/// Shared by every caller in this module so the OCR pass, the proofread pass
/// and the image-assisted proofread pass cannot drift apart on error mapping —
/// which status codes count as retryable, and how much of an upstream body is
/// echoed back, are decisions that belong in exactly one place.
async fn post_chat(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    body: &ChatRequest<'_>,
    provider_label: &str,
) -> AppResult<String> {
    let url = join(base_url, "/chat/completions");
    let resp = client
        .post(&url)
        .bearer_auth(key)
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| AppError::Ocr {
            provider: provider_label.into(),
            message: format!("network: {e}"),
            retryable: e.is_timeout() || e.is_connect(),
        })?;

    let status = resp.status();
    if !status.is_success() {
        let retryable = status.as_u16() == 429 || status.is_server_error();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Ocr {
            provider: provider_label.into(),
            message: format!(
                "HTTP {status}: {}",
                body.chars().take(200).collect::<String>()
            ),
            retryable,
        });
    }

    let parsed: ChatResponse = resp.json().await.map_err(|e| AppError::Ocr {
        provider: provider_label.into(),
        message: format!("parse: {e}"),
        retryable: false,
    })?;

    choice_text(parsed, provider_label)
}

/// Takes the first choice, refusing silently truncated output. A model that
/// ran into the `max_tokens` cap produces half a sentence (or, for the
/// proofread pass, half a JSON array) — reporting it as a real error beats
/// shipping the user a document with the tail missing and no explanation.
fn choice_text(parsed: ChatResponse, provider_label: &str) -> AppResult<String> {
    let choice = parsed
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Ocr {
            provider: provider_label.into(),
            message: "empty choices in response".into(),
            retryable: false,
        })?;
    if matches!(
        choice.finish_reason.as_deref(),
        Some("length") | Some("max_tokens")
    ) {
        return Err(AppError::Ocr {
            provider: provider_label.into(),
            message: crate::tr!(
                "模型响应因达到 max_tokens 上限被截断，结果不完整。",
                "The model response was truncated at the max_tokens limit and is incomplete."
            )
            .into(),
            retryable: false,
        });
    }
    Ok(choice.message.content.trim().to_string())
}

/// One chat-completions call for the proofread pass. Shares the
/// request/error handling with [`recognize`] but takes a system + user
/// message pair, and takes `max_tokens` as a parameter: a page of correction
/// suggestions is far longer than a page of OCR text, so the OCR path's fixed
/// 4096 would silently cut the JSON in half.
///
/// `images_b64` are **raw base64 payloads without a `data:` prefix** — the
/// `data:image/jpeg;base64,` wrapper is added here so a caller can never
/// choose the mime type (the desktop encodes JPEG, and the server accepts the
/// same from an untrusted caller). An empty slice sends the plain-text body,
/// byte for byte what this function sent before images existed.
#[allow(clippy::too_many_arguments)]
pub async fn chat_text(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
    images_b64: &[String],
    max_tokens: u32,
    provider_label: &str,
    cancel: &CancellationToken,
) -> AppResult<String> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(AppError::Cancelled(provider_label.into())),
        result = chat_text_inner(
            client, base_url, key, model, system_prompt, user_prompt, images_b64,
            max_tokens, provider_label,
        ) => result,
    }
}

#[allow(clippy::too_many_arguments)]
async fn chat_text_inner(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
    images_b64: &[String],
    max_tokens: u32,
    provider_label: &str,
) -> AppResult<String> {
    if key.is_empty() {
        return Err(AppError::Config(crate::trf!(
            "{}：尚未配置 API Key，请在设置中填入。",
            "{}: no API key configured — set one in Settings.",
            provider_label
        )));
    }
    if model.is_empty() {
        return Err(AppError::Config(crate::trf!(
            "{}：尚未配置模型。",
            "{}: no model configured.",
            provider_label
        )));
    }

    // Built up front so the parts below can borrow them: `ContentPart` holds
    // `&str`, and a URL formatted inside the `map` would not outlive the body.
    let data_urls: Vec<String> = images_b64
        .iter()
        .map(|b64| format!("data:image/jpeg;base64,{b64}"))
        .collect();

    let user_content = if data_urls.is_empty() {
        MessageContent::Text(user_prompt)
    } else {
        // Images first, then the text — the same order `recognize` uses, so
        // both passes present a page to the model the same way.
        let mut parts: Vec<ContentPart> = data_urls
            .iter()
            .map(|url| ContentPart::ImageUrl {
                image_url: ImageUrlData { url },
            })
            .collect();
        parts.push(ContentPart::Text { text: user_prompt });
        MessageContent::Parts(parts)
    };

    let body = ChatRequest {
        model,
        messages: vec![
            Message {
                role: "system",
                content: MessageContent::Text(system_prompt),
            },
            Message {
                role: "user",
                content: user_content,
            },
        ],
        max_tokens,
    };

    post_chat(client, base_url, key, &body, provider_label).await
}

/// How much of an upstream failure to repeat back to the caller.
///
/// On the desktop the detail is worth showing: a `401` means "wrong key" and a
/// `404` means "wrong base URL", and the only reader is the person who typed
/// both. On a network-facing server the same string turns the models endpoint
/// into a probe oracle for whichever host the caller named, so it collapses to
/// one opaque wording. (The `retryable` flag still separates 429/5xx from the
/// rest — a much coarser signal, kept because the retry schedule needs it.)
fn upstream_detail(detail: impl FnOnce() -> String) -> String {
    match super::base_url::policy() {
        super::base_url::BaseUrlPolicy::LocalTrusted => detail(),
        super::base_url::BaseUrlPolicy::NetworkFacing => crate::tr!(
            "上游模型服务不可用。",
            "Upstream model service is unavailable."
        )
        .to_string(),
    }
}

/// Fetches the model list from `{base_url}/models`. Used by the refresh-models
/// button
/// in the settings dialog. Sorts ids alphabetically for stable UI.
pub async fn list_models(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    provider_label: &str,
) -> AppResult<Vec<String>> {
    if key.is_empty() {
        return Err(AppError::Config(crate::trf!(
            "{}：尚未配置 API Key，请在设置中填入。",
            "{}: no API key configured — set one in Settings.",
            provider_label
        )));
    }

    let url = join(base_url, "/models");
    let resp = client
        .get(&url)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| AppError::Ocr {
            provider: provider_label.into(),
            message: upstream_detail(|| format!("network: {e}")),
            retryable: e.is_timeout() || e.is_connect(),
        })?;

    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Ocr {
            provider: provider_label.into(),
            message: upstream_detail(|| format!("models: HTTP {status}")),
            retryable: status.as_u16() == 429 || status.is_server_error(),
        });
    }

    let parsed: ModelsResponse = resp.json().await.map_err(|e| AppError::Ocr {
        provider: provider_label.into(),
        message: upstream_detail(|| format!("models parse: {e}")),
        retryable: false,
    })?;

    let mut ids: Vec<String> = parsed.data.into_iter().map(|m| m.id).collect();
    ids.sort();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{Duration, Instant};
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn happy_path_returns_first_choice_content() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(header("Authorization", "Bearer sk-test"))
            .and(body_partial_json(
                json!({ "model": "gpt-4o", "max_tokens": 4096 }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{ "message": { "content": "  hello\n" } }]
            })))
            .mount(&server)
            .await;

        let out = recognize(
            &reqwest::Client::new(),
            &server.uri(),
            "sk-test",
            "gpt-4o",
            "prompt",
            b"PNGBYTES",
            "openai",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(out, "hello");
    }

    #[tokio::test]
    async fn image_payload_uses_data_url() {
        let server = MockServer::start().await;
        // base64 of "ABC" is "QUJD"
        let expected_url = format!("data:image/jpeg;base64,{}", STANDARD.encode(b"ABC"));
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(body_partial_json(json!({
                "messages": [{
                    "content": [
                        { "type": "image_url", "image_url": { "url": expected_url } },
                        { "type": "text", "text": "扫一扫" }
                    ]
                }]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{ "message": { "content": "ok" } }]
            })))
            .mount(&server)
            .await;

        let out = recognize(
            &reqwest::Client::new(),
            &server.uri(),
            "sk-test",
            "gpt-4o",
            "扫一扫",
            b"ABC",
            "openai",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(out, "ok");
    }

    #[tokio::test]
    async fn rate_limit_marks_retryable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(429))
            .mount(&server)
            .await;

        let err = recognize(
            &reqwest::Client::new(),
            &server.uri(),
            "sk",
            "gpt-4o",
            "p",
            b"x",
            "openai",
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert!(err.is_retryable());
    }

    #[tokio::test]
    async fn auth_4xx_not_retryable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let err = recognize(
            &reqwest::Client::new(),
            &server.uri(),
            "sk",
            "gpt-4o",
            "p",
            b"x",
            "openai",
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert!(!err.is_retryable());
    }

    #[tokio::test]
    async fn cancel_aborts_an_in_flight_request() {
        let server = MockServer::start().await;
        // Far longer than the assertion below tolerates: if cancellation only
        // took effect between calls, this test would hang for 30s and then
        // return Ok instead of Cancelled.
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_secs(30))
                    .set_body_json(json!({
                        "choices": [{ "message": { "content": "too late" } }]
                    })),
            )
            .mount(&server)
            .await;

        let cancel = CancellationToken::new();
        let token = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            token.cancel();
        });

        let started = Instant::now();
        let err = recognize(
            &reqwest::Client::new(),
            &server.uri(),
            "sk",
            "gpt-4o",
            "p",
            b"x",
            "openai",
            &cancel,
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::Cancelled(_)), "got {err:?}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cancel waited for the response instead of dropping the request"
        );
    }

    #[tokio::test]
    async fn cancelled_is_not_retryable() {
        // `recognize_with_retry` must not resubmit the image after a cancel.
        assert!(!AppError::Cancelled("openai".into()).is_retryable());
    }

    #[tokio::test]
    async fn list_models_returns_sorted_ids() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .and(header("Authorization", "Bearer sk"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": [
                    { "id": "gpt-4o-mini" },
                    { "id": "gpt-4o" },
                    { "id": "gpt-4.1" }
                ]
            })))
            .mount(&server)
            .await;

        let ids = list_models(&reqwest::Client::new(), &server.uri(), "sk", "openai")
            .await
            .unwrap();
        assert_eq!(ids, vec!["gpt-4.1", "gpt-4o", "gpt-4o-mini"]);
    }

    #[tokio::test]
    async fn chat_text_sends_system_user_pair_and_custom_max_tokens() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(body_partial_json(json!({
                "model": "anthropic/claude-x",
                "max_tokens": 16384,
                "messages": [
                    { "role": "system", "content": "只修 OCR 误识" },
                    { "role": "user", "content": "巳於昨日" }
                ]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{
                    "message": { "content": "[]" },
                    "finish_reason": "stop"
                }]
            })))
            .mount(&server)
            .await;

        let out = chat_text(
            &reqwest::Client::new(),
            &server.uri(),
            "sk",
            "anthropic/claude-x",
            "只修 OCR 误识",
            "巳於昨日",
            &[],
            16384,
            "openrouter",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(out, "[]");
    }

    #[tokio::test]
    async fn chat_text_with_images_sends_a_parts_array_for_the_user_message() {
        let server = MockServer::start().await;
        // A cross-page article sends one image per page it touches; both must
        // arrive, wrapped by us as jpeg data URLs, ahead of the text.
        let first = STANDARD.encode(b"ABC");
        let second = STANDARD.encode(b"DEF");
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(body_partial_json(json!({
                "messages": [
                    { "role": "system", "content": "只修 OCR 误识" },
                    {
                        "role": "user",
                        "content": [
                            { "type": "image_url", "image_url": {
                                "url": format!("data:image/jpeg;base64,{first}") } },
                            { "type": "image_url", "image_url": {
                                "url": format!("data:image/jpeg;base64,{second}") } },
                            { "type": "text", "text": "巳於昨日" }
                        ]
                    }
                ]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{ "message": { "content": "[]" }, "finish_reason": "stop" }]
            })))
            .mount(&server)
            .await;

        let out = chat_text(
            &reqwest::Client::new(),
            &server.uri(),
            "sk",
            "gpt-4o",
            "只修 OCR 误识",
            "巳於昨日",
            &[first.clone(), second.clone()],
            16384,
            "openai",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(out, "[]");
    }

    #[tokio::test]
    async fn chat_text_without_images_sends_a_plain_string_content() {
        // The text-only body must stay byte-identical to what shipped before
        // images existed: a bare string, not a one-element parts array that a
        // minimal OpenAI-compatible endpoint might not accept.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(body_partial_json(json!({
                "messages": [
                    { "role": "system", "content": "sys" },
                    { "role": "user", "content": "巳於昨日" }
                ]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{ "message": { "content": "[]" }, "finish_reason": "stop" }]
            })))
            .mount(&server)
            .await;

        let out = chat_text(
            &reqwest::Client::new(),
            &server.uri(),
            "sk",
            "m",
            "sys",
            "巳於昨日",
            &[],
            16384,
            "openai",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(out, "[]");
    }

    #[tokio::test]
    async fn chat_text_rejects_length_terminated_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{
                    "message": { "content": "[{ \"before\": " },
                    "finish_reason": "length"
                }]
            })))
            .mount(&server)
            .await;

        let err = chat_text(
            &reqwest::Client::new(),
            &server.uri(),
            "sk",
            "m",
            "sys",
            "user",
            &[],
            16384,
            "openai",
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        match err {
            AppError::Ocr {
                message, retryable, ..
            } => {
                assert!(
                    message.contains("截断") || message.contains("truncated"),
                    "{message}"
                );
                assert!(!retryable);
            }
            other => panic!("expected Ocr, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn chat_text_cancel_aborts_in_flight_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_secs(30))
                    .set_body_json(json!({
                        "choices": [{ "message": { "content": "too late" } }]
                    })),
            )
            .mount(&server)
            .await;

        let cancel = CancellationToken::new();
        let token = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            token.cancel();
        });

        let started = Instant::now();
        let err = chat_text(
            &reqwest::Client::new(),
            &server.uri(),
            "sk",
            "m",
            "sys",
            "user",
            &[],
            16384,
            "openai",
            &cancel,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Cancelled(_)), "got {err:?}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn join_trims_trailing_slash() {
        assert_eq!(
            join("https://x.com/v1/", "/models"),
            "https://x.com/v1/models"
        );
        assert_eq!(
            join("https://x.com/v1", "/models"),
            "https://x.com/v1/models"
        );
    }
}
