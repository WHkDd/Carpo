//! PaddleOCR (Baidu AI Studio) async OCR jobs API.
//!
//! Replaces the synchronous `/v2/ocr` endpoint that ships in
//! `newspaper_ocr.py:_recognize_paddleocr` — the official sync API is being
//! retired and the async jobs API is the supported replacement (docs:
//! https://ai.baidu.com/ai-doc/AISTUDIO/fml7mozw5).
//!
//! Flow:
//! 1. `POST {job_url}` multipart with the page bytes → `{data:{jobId}}`.
//! 2. `GET  {job_url}/{jobId}` until `data.state == "done"` (or `"failed"`).
//! 3. `GET  data.resultUrl.jsonUrl` → JSONL of `{result:{layoutParsingResults:
//!    [{markdown:{text,...}}]}}`. Concatenate non-empty `markdown.text` with
//!    `\n` to match the Python sync-API behaviour callers already rely on.
//!
//! Default endpoint: `https://paddleocr.aistudio-app.com/api/v2/ocr/jobs`.
//! Default model: `PaddleOCR-VL-1.6`.

use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};

const PROVIDER: &str = "paddleocr";
pub const DEFAULT_JOB_URL: &str = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
pub const DEFAULT_MODEL: &str = "PaddleOCR-VL-1.6";

/// `data` is `Option` because Baidu's error responses (e.g. `10010` "queue
/// full") sometimes omit it or send `null` — with a required `T` those
/// responses fail JSON deserialization *before* we get a chance to read
/// `code`, turning a retryable API error into an opaque non-retryable
/// "parse: ..." error.
#[derive(Deserialize)]
struct Envelope<T> {
    #[serde(default)]
    code: i32,
    #[serde(default)]
    msg: Option<String>,
    data: Option<T>,
}

impl<T> Envelope<T> {
    fn into_data(self, stage: &str) -> AppResult<T> {
        if self.code != 0 {
            return Err(ocr_err(
                stage,
                format!("code {} {}", self.code, self.msg.unwrap_or_default()),
                is_api_code_retryable(self.code),
            ));
        }
        self.data
            .ok_or_else(|| ocr_err(stage, "response missing data", false))
    }
}

#[derive(Deserialize)]
struct SubmitData {
    #[serde(rename = "jobId")]
    job_id: String,
}

#[derive(Deserialize)]
struct PollData {
    state: String,
    #[serde(rename = "errorMsg", default)]
    error_msg: Option<String>,
    #[serde(rename = "resultUrl", default)]
    result_url: Option<ResultUrl>,
}

#[derive(Deserialize, Default)]
struct ResultUrl {
    #[serde(rename = "jsonUrl", default)]
    json_url: Option<String>,
}

#[derive(Deserialize)]
struct JsonlLine {
    result: JsonlResult,
}

#[derive(Deserialize)]
struct JsonlResult {
    #[serde(rename = "layoutParsingResults", default)]
    layout_parsing_results: Vec<LayoutItem>,
}

#[derive(Deserialize)]
struct LayoutItem {
    #[serde(default)]
    markdown: Markdown,
}

#[derive(Deserialize, Default)]
struct Markdown {
    #[serde(default)]
    text: String,
}

/// Documented retryable Baidu API codes (in addition to standard 429 / 5xx).
/// `500` is "system error, retry later"; `10010` is "task submission queue
/// full, retry later". All other documented codes are user-input failures.
fn is_api_code_retryable(code: i32) -> bool {
    matches!(code, 500 | 10010)
}

fn http_retryable(status: reqwest::StatusCode) -> bool {
    status.as_u16() == 429 || status.is_server_error()
}

fn ocr_err(stage: &str, msg: impl Into<String>, retryable: bool) -> AppError {
    AppError::Ocr {
        provider: format!("{PROVIDER}/{stage}"),
        message: msg.into(),
        retryable,
    }
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

#[allow(clippy::too_many_arguments)]
pub async fn recognize(
    client: &reqwest::Client,
    job_url: &str,
    token: &str,
    model: &str,
    image_bytes: Vec<u8>,
    poll_interval: Duration,
    poll_timeout: Duration,
    cancel: &CancellationToken,
) -> AppResult<String> {
    if token.is_empty() {
        return Err(AppError::Config(
            crate::tr!(
                "PaddleOCR：尚未配置 Token，请在设置中填入。",
                "PaddleOCR: no token configured — set one in Settings."
            )
            .into(),
        ));
    }
    let job_url = if job_url.is_empty() {
        DEFAULT_JOB_URL
    } else {
        job_url.trim_end_matches('/')
    };
    let model = if model.is_empty() {
        DEFAULT_MODEL
    } else {
        model
    };

    let job_id = submit(client, job_url, token, model, image_bytes).await?;
    let json_url = poll(
        client,
        job_url,
        token,
        &job_id,
        poll_interval,
        poll_timeout,
        cancel,
    )
    .await?;
    fetch_result(client, &json_url).await
}

async fn submit(
    client: &reqwest::Client,
    job_url: &str,
    token: &str,
    model: &str,
    image_bytes: Vec<u8>,
) -> AppResult<String> {
    let optional_payload = serde_json::json!({
        "useDocOrientationClassify": false,
        "useDocUnwarping": false,
        "useChartRecognition": false,
    })
    .to_string();

    let part = reqwest::multipart::Part::bytes(image_bytes)
        .file_name("page.jpg")
        .mime_str("image/jpeg")
        .map_err(|e| AppError::Internal(format!("multipart mime: {e}")))?;
    let form = reqwest::multipart::Form::new()
        .text("model", model.to_string())
        .text("optionalPayload", optional_payload)
        .part("file", part);

    let resp = client
        .post(job_url)
        .header("Authorization", format!("Bearer {token}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            ocr_err(
                "submit",
                format!("network: {e}"),
                e.is_timeout() || e.is_connect(),
            )
        })?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(ocr_err(
            "submit",
            format!("HTTP {status}: {}", truncate(&body, 200)),
            http_retryable(status),
        ));
    }

    let env: Envelope<SubmitData> = resp
        .json()
        .await
        .map_err(|e| ocr_err("submit", format!("parse: {e}"), false))?;
    Ok(env.into_data("submit")?.job_id)
}

#[allow(clippy::too_many_arguments)]
async fn poll(
    client: &reqwest::Client,
    job_url: &str,
    token: &str,
    job_id: &str,
    interval: Duration,
    overall_timeout: Duration,
    cancel: &CancellationToken,
) -> AppResult<String> {
    // A single transient network blip or 5xx shouldn't discard the whole
    // job — `recognize_with_retry` reacting to it would resubmit the image
    // and re-queue from scratch. Tolerate a handful of consecutive
    // transient failures before giving up.
    const MAX_CONSECUTIVE_TRANSIENT_FAILURES: u32 = 5;

    let url = format!("{job_url}/{job_id}");
    let start = Instant::now();
    let auth = format!("Bearer {token}");
    let mut consecutive_failures: u32 = 0;
    loop {
        if cancel.is_cancelled() {
            return Err(AppError::Cancelled("paddle poll".into()));
        }
        if start.elapsed() > overall_timeout {
            return Err(ocr_err("poll", "timeout waiting for job to finish", false));
        }

        match poll_once(client, &url, &auth).await {
            Ok(PollOutcome::Pending) => {
                consecutive_failures = 0;
            }
            Ok(PollOutcome::Done(json_url)) => return Ok(json_url),
            Ok(PollOutcome::Failed(msg)) => {
                return Err(ocr_err("job", format!("job failed: {msg}"), false));
            }
            Err(e) if e.is_retryable() => {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_CONSECUTIVE_TRANSIENT_FAILURES {
                    return Err(e);
                }
            }
            Err(e) => return Err(e),
        }

        // pending / running / transient failure: keep polling. Race the
        // sleep against cancellation so a user-driven cancel doesn't wait
        // out the full interval (or, worse, poll_timeout).
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = cancel.cancelled() => {
                return Err(AppError::Cancelled("paddle poll".into()));
            }
        }
    }
}

enum PollOutcome {
    Pending,
    Done(String),
    Failed(String),
}

async fn poll_once(client: &reqwest::Client, url: &str, auth: &str) -> AppResult<PollOutcome> {
    let resp = client
        .get(url)
        .header("Authorization", auth)
        .send()
        .await
        .map_err(|e| {
            ocr_err(
                "poll",
                format!("network: {e}"),
                e.is_timeout() || e.is_connect(),
            )
        })?;
    let status = resp.status();
    if !status.is_success() {
        return Err(ocr_err(
            "poll",
            format!("HTTP {status}"),
            http_retryable(status),
        ));
    }
    let env: Envelope<PollData> = resp
        .json()
        .await
        .map_err(|e| ocr_err("poll", format!("parse: {e}"), false))?;
    let data = env.into_data("poll")?;

    match data.state.as_str() {
        "done" => {
            let json_url = data
                .result_url
                .and_then(|r| r.json_url)
                .ok_or_else(|| ocr_err("poll", "done state missing resultUrl.jsonUrl", false))?;
            Ok(PollOutcome::Done(json_url))
        }
        "failed" => Ok(PollOutcome::Failed(
            data.error_msg.unwrap_or_else(|| "unknown error".into()),
        )),
        _ => Ok(PollOutcome::Pending),
    }
}

async fn fetch_result(client: &reqwest::Client, json_url: &str) -> AppResult<String> {
    let resp = client.get(json_url).send().await.map_err(|e| {
        ocr_err(
            "result",
            format!("network: {e}"),
            e.is_timeout() || e.is_connect(),
        )
    })?;
    let status = resp.status();
    if !status.is_success() {
        return Err(ocr_err(
            "result",
            format!("HTTP {status}"),
            http_retryable(status),
        ));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| ocr_err("result", format!("body: {e}"), false))?;

    let mut parts: Vec<String> = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parsed: JsonlLine = serde_json::from_str(line)
            .map_err(|e| ocr_err("result", format!("jsonl line: {e}"), false))?;
        for item in parsed.result.layout_parsing_results {
            let t = item.markdown.text.trim();
            if !t.is_empty() {
                parts.push(t.to_string());
            }
        }
    }
    Ok(parts.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const FAST_POLL: Duration = Duration::from_millis(5);
    const POLL_CAP: Duration = Duration::from_secs(10);

    fn never_cancelled() -> CancellationToken {
        CancellationToken::new()
    }

    fn jsonl_body() -> String {
        let line1 = json!({
            "result": {
                "layoutParsingResults": [
                    { "markdown": { "text": "page 1 line A" } }
                ]
            }
        });
        let line2 = json!({
            "result": {
                "layoutParsingResults": [
                    { "markdown": { "text": "  page 2 line A  " } },
                    { "markdown": { "text": "" } },
                    { "markdown": { "text": "page 2 line B" } }
                ]
            }
        });
        format!("{}\n{}", line1, line2)
    }

    #[tokio::test]
    async fn happy_path_submits_polls_and_joins_markdown() {
        let server = MockServer::start().await;
        let base = server.uri();
        let json_url = format!("{base}/result.jsonl");

        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .and(header("Authorization", "Bearer tk"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "msg": "Success", "data": { "jobId": "ocrjob-abc" }
            })))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/api/v2/ocr/jobs/ocrjob-abc"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "msg": "Success",
                "data": { "state": "done", "resultUrl": { "jsonUrl": json_url } }
            })))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/result.jsonl"))
            .respond_with(ResponseTemplate::new(200).set_body_string(jsonl_body()))
            .mount(&server)
            .await;

        let cancel = never_cancelled();
        let out = recognize(
            &reqwest::Client::new(),
            &format!("{base}/api/v2/ocr/jobs"),
            "tk",
            "PaddleOCR-VL-1.6",
            b"PNGBYTES".to_vec(),
            FAST_POLL,
            POLL_CAP,
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(out, "page 1 line A\npage 2 line A\npage 2 line B");
    }

    #[tokio::test]
    async fn pending_then_done_keeps_polling() {
        let server = MockServer::start().await;
        let base = server.uri();
        let json_url = format!("{base}/r.jsonl");

        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "jobId": "j1" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v2/ocr/jobs/j1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "state": "pending" }
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v2/ocr/jobs/j1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "state": "running", "extractProgress": { "totalPages": 1, "extractedPages": 0 } }
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v2/ocr/jobs/j1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "state": "done", "resultUrl": { "jsonUrl": json_url } }
            })))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/r.jsonl"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                json!({ "result": { "layoutParsingResults": [{ "markdown": { "text": "ok" } }] } })
                    .to_string(),
            ))
            .mount(&server)
            .await;

        let cancel = never_cancelled();
        let out = recognize(
            &reqwest::Client::new(),
            &format!("{base}/api/v2/ocr/jobs"),
            "tk",
            "",
            b"x".to_vec(),
            FAST_POLL,
            POLL_CAP,
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(out, "ok");
    }

    #[tokio::test]
    async fn failed_state_returns_non_retryable_with_error_msg() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "jobId": "j2" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v2/ocr/jobs/j2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0,
                "data": { "state": "failed", "errorMsg": "文件格式不支持" }
            })))
            .mount(&server)
            .await;

        let cancel = never_cancelled();
        let err = recognize(
            &reqwest::Client::new(),
            &format!("{}/api/v2/ocr/jobs", server.uri()),
            "tk",
            "",
            b"x".to_vec(),
            FAST_POLL,
            POLL_CAP,
            &cancel,
        )
        .await
        .unwrap_err();
        assert!(!err.is_retryable());
        match err {
            AppError::Ocr { message, .. } => assert!(message.contains("文件格式不支持")),
            other => panic!("expected Ocr, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn submit_5xx_marks_retryable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let cancel = never_cancelled();
        let err = recognize(
            &reqwest::Client::new(),
            &format!("{}/api/v2/ocr/jobs", server.uri()),
            "tk",
            "",
            b"x".to_vec(),
            FAST_POLL,
            POLL_CAP,
            &cancel,
        )
        .await
        .unwrap_err();
        assert!(err.is_retryable());
    }

    #[tokio::test]
    async fn submit_401_not_retryable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let cancel = never_cancelled();
        let err = recognize(
            &reqwest::Client::new(),
            &format!("{}/api/v2/ocr/jobs", server.uri()),
            "tk",
            "",
            b"x".to_vec(),
            FAST_POLL,
            POLL_CAP,
            &cancel,
        )
        .await
        .unwrap_err();
        assert!(!err.is_retryable());
    }

    #[tokio::test]
    async fn submit_api_code_10010_marks_retryable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 10010, "msg": "任务提交队列已满", "data": { "jobId": "" }
            })))
            .mount(&server)
            .await;

        let cancel = never_cancelled();
        let err = recognize(
            &reqwest::Client::new(),
            &format!("{}/api/v2/ocr/jobs", server.uri()),
            "tk",
            "",
            b"x".to_vec(),
            FAST_POLL,
            POLL_CAP,
            &cancel,
        )
        .await
        .unwrap_err();
        assert!(err.is_retryable());
    }

    #[tokio::test]
    async fn submit_api_code_10010_with_null_data_marks_retryable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 10010, "msg": "任务提交队列已满", "data": null
            })))
            .mount(&server)
            .await;

        let cancel = never_cancelled();
        let err = recognize(
            &reqwest::Client::new(),
            &format!("{}/api/v2/ocr/jobs", server.uri()),
            "tk",
            "",
            b"x".to_vec(),
            FAST_POLL,
            POLL_CAP,
            &cancel,
        )
        .await
        .unwrap_err();
        assert!(err.is_retryable());
        match err {
            AppError::Ocr { message, .. } => assert!(message.contains("code 10010")),
            other => panic!("expected Ocr, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn submit_api_code_10004_not_retryable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 10004, "msg": "文件格式不支持", "data": { "jobId": "" }
            })))
            .mount(&server)
            .await;

        let cancel = never_cancelled();
        let err = recognize(
            &reqwest::Client::new(),
            &format!("{}/api/v2/ocr/jobs", server.uri()),
            "tk",
            "",
            b"x".to_vec(),
            FAST_POLL,
            POLL_CAP,
            &cancel,
        )
        .await
        .unwrap_err();
        assert!(!err.is_retryable());
    }

    #[tokio::test]
    async fn missing_token_returns_config_error() {
        let cancel = never_cancelled();
        let err = recognize(
            &reqwest::Client::new(),
            DEFAULT_JOB_URL,
            "",
            "",
            b"x".to_vec(),
            FAST_POLL,
            POLL_CAP,
            &cancel,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Config(_)));
    }

    #[tokio::test]
    async fn poll_timeout_eventually_gives_up() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "jobId": "stuck" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v2/ocr/jobs/stuck"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "state": "pending" }
            })))
            .mount(&server)
            .await;

        let cancel = never_cancelled();
        let err = recognize(
            &reqwest::Client::new(),
            &format!("{}/api/v2/ocr/jobs", server.uri()),
            "tk",
            "",
            b"x".to_vec(),
            Duration::from_millis(5),
            Duration::from_millis(20),
            &cancel,
        )
        .await
        .unwrap_err();
        match err {
            AppError::Ocr {
                message, retryable, ..
            } => {
                assert!(message.contains("timeout"));
                assert!(!retryable);
            }
            other => panic!("expected Ocr, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn cancel_during_poll_returns_cancelled() {
        // poll_interval is large; cancel after 20ms must short-circuit the
        // sleep rather than waiting it out.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "jobId": "stuck" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v2/ocr/jobs/stuck"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "state": "pending" }
            })))
            .mount(&server)
            .await;

        let cancel = CancellationToken::new();
        let cancel_clone = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel_clone.cancel();
        });
        let started = Instant::now();
        let err = recognize(
            &reqwest::Client::new(),
            &format!("{}/api/v2/ocr/jobs", server.uri()),
            "tk",
            "",
            b"x".to_vec(),
            Duration::from_secs(5),
            Duration::from_secs(30),
            &cancel,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Cancelled(_)));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
