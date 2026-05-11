//! PaddleOCR vision recognition.
//!
//! Mirrors the request/response shape used by `newspaper_ocr.py:_recognize_paddleocr`:
//! POST `{api_url}` with `Authorization: token {token}` and a JSON body wrapping
//! the base64-encoded page image. Response text is concatenated from the
//! `result.layoutParsingResults[].markdown.text` field.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const PROVIDER: &str = "paddleocr";

#[derive(Serialize)]
struct Request<'a> {
    file: &'a str,
    #[serde(rename = "fileType")]
    file_type: u8,
    #[serde(rename = "useDocOrientationClassify")]
    use_doc_orientation_classify: bool,
    #[serde(rename = "useDocUnwarping")]
    use_doc_unwarping: bool,
    #[serde(rename = "useChartRecognition")]
    use_chart_recognition: bool,
}

#[derive(Deserialize)]
struct Response {
    result: Option<ResponseResult>,
}

#[derive(Deserialize)]
struct ResponseResult {
    #[serde(rename = "layoutParsingResults", default)]
    layout_parsing_results: Vec<LayoutResult>,
}

#[derive(Deserialize)]
struct LayoutResult {
    #[serde(default)]
    markdown: Markdown,
}

#[derive(Deserialize, Default)]
struct Markdown {
    #[serde(default)]
    text: String,
}

pub async fn recognize(
    client: &reqwest::Client,
    api_url: &str,
    token: &str,
    png_b64: &str,
) -> AppResult<String> {
    if api_url.is_empty() {
        return Err(AppError::Config(
            "PaddleOCR：尚未配置 Endpoint，请在设置中填入。".into(),
        ));
    }
    if token.is_empty() {
        return Err(AppError::Config(
            "PaddleOCR：尚未配置 Token，请在设置中填入。".into(),
        ));
    }

    let body = Request {
        file: png_b64,
        file_type: 1,
        use_doc_orientation_classify: false,
        use_doc_unwarping: false,
        use_chart_recognition: false,
    };

    let resp = client
        .post(api_url)
        .header("Authorization", format!("token {token}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Ocr {
            provider: PROVIDER.into(),
            message: format!("network: {e}"),
            retryable: e.is_timeout() || e.is_connect(),
        })?;

    let status = resp.status();
    if !status.is_success() {
        let retryable = status.as_u16() == 429 || status.is_server_error();
        return Err(AppError::Ocr {
            provider: PROVIDER.into(),
            message: format!("HTTP {status}"),
            retryable,
        });
    }

    let parsed: Response = resp.json().await.map_err(|e| AppError::Ocr {
        provider: PROVIDER.into(),
        message: format!("parse: {e}"),
        retryable: false,
    })?;

    let parts: Vec<String> = parsed
        .result
        .map(|r| r.layout_parsing_results)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|res| {
            let t = res.markdown.text.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        })
        .collect();

    Ok(parts.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn happy_path_joins_markdown_text() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ocr"))
            .and(header("Authorization", "token tk"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "result": {
                    "layoutParsingResults": [
                        { "markdown": { "text": "第一块" } },
                        { "markdown": { "text": "  第二块  " } },
                        { "markdown": { "text": "" } }
                    ]
                }
            })))
            .mount(&server)
            .await;

        let url = format!("{}/ocr", server.uri());
        let out = recognize(&reqwest::Client::new(), &url, "tk", "PNGB64==")
            .await
            .unwrap();
        assert_eq!(out, "第一块\n第二块");
    }

    #[tokio::test]
    async fn server_5xx_marks_retryable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ocr"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let url = format!("{}/ocr", server.uri());
        let err = recognize(&reqwest::Client::new(), &url, "tk", "x")
            .await
            .unwrap_err();
        assert!(err.is_retryable());
        assert!(matches!(err, AppError::Ocr { .. }));
    }

    #[tokio::test]
    async fn client_4xx_not_retryable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ocr"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let url = format!("{}/ocr", server.uri());
        let err = recognize(&reqwest::Client::new(), &url, "tk", "x")
            .await
            .unwrap_err();
        assert!(!err.is_retryable());
    }

    #[tokio::test]
    async fn missing_endpoint_returns_config_error() {
        let err = recognize(&reqwest::Client::new(), "", "tk", "x")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Config(_)));
    }
}
