//! OpenAI (and OpenAI-compatible) chat completions vision recognition.
//!
//! Implements `POST {base_url}/chat/completions` with `Authorization: Bearer
//! {key}`, sending a single user message that pairs the page image (as a
//! `data:image/png;base64,...` URL) with the OCR prompt. The same shape
//! powers OpenAI proper, OpenRouter, and any OpenAI-compatible endpoint —
//! the only thing that differs is `base_url`.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const OFFICIAL_BASE_URL: &str = "https://api.openai.com/v1";
pub const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";

const MAX_TOKENS: u32 = 4096;

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: [Message<'a>; 1],
    max_tokens: u32,
}

#[derive(Serialize)]
struct Message<'a> {
    role: &'a str,
    content: [ContentPart<'a>; 2],
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

pub async fn recognize(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    model: &str,
    prompt: &str,
    png_b64: &str,
    provider_label: &str,
) -> AppResult<String> {
    if key.is_empty() {
        return Err(AppError::Config(format!(
            "{provider_label}：尚未配置 API Key，请在设置中填入。"
        )));
    }
    if model.is_empty() {
        return Err(AppError::Config(format!(
            "{provider_label}：尚未配置模型。"
        )));
    }

    let data_url = format!("data:image/png;base64,{png_b64}");
    let body = ChatRequest {
        model,
        messages: [Message {
            role: "user",
            content: [
                ContentPart::ImageUrl {
                    image_url: ImageUrlData { url: &data_url },
                },
                ContentPart::Text { text: prompt },
            ],
        }],
        max_tokens: MAX_TOKENS,
    };

    let url = join(base_url, "/chat/completions");
    let resp = client
        .post(&url)
        .bearer_auth(key)
        .header("Content-Type", "application/json")
        .json(&body)
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

    let text = parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content.trim().to_string())
        .ok_or_else(|| AppError::Ocr {
            provider: provider_label.into(),
            message: "empty choices in response".into(),
            retryable: false,
        })?;

    Ok(text)
}

/// Fetches the model list from `{base_url}/models`. Used by the "刷新模型" button
/// in the settings dialog. Sorts ids alphabetically for stable UI.
pub async fn list_models(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    provider_label: &str,
) -> AppResult<Vec<String>> {
    if key.is_empty() {
        return Err(AppError::Config(format!(
            "{provider_label}：尚未配置 API Key，请在设置中填入。"
        )));
    }

    let url = join(base_url, "/models");
    let resp = client.get(&url).bearer_auth(key).send().await?;

    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Ocr {
            provider: provider_label.into(),
            message: format!("models: HTTP {status}"),
            retryable: status.as_u16() == 429 || status.is_server_error(),
        });
    }

    let parsed: ModelsResponse = resp.json().await.map_err(|e| AppError::Ocr {
        provider: provider_label.into(),
        message: format!("models parse: {e}"),
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
            "PNGB64==",
            "openai",
        )
        .await
        .unwrap();
        assert_eq!(out, "hello");
    }

    #[tokio::test]
    async fn image_payload_uses_data_url() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(body_partial_json(json!({
                "messages": [{
                    "content": [
                        { "type": "image_url", "image_url": { "url": "data:image/png;base64,ABC=" } },
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
            "ABC=",
            "openai",
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
            "x",
            "openai",
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
            "x",
            "openai",
        )
        .await
        .unwrap_err();
        assert!(!err.is_retryable());
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
