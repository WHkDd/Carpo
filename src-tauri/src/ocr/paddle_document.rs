//! PaddleOCR document-level OCR job (multi-page PDF upload).
//!
//! Companion to [`super::paddle`], which handles single-image / cropped-block
//! requests. The document path uploads the full PDF (or image) in one
//! multipart request with an optional `pageRanges` filter, polls the async
//! jobs endpoint until completion (emitting `extractProgress` events along
//! the way), then parses the JSONL result into one [`DocPageResult`] per
//! page mapped back to the **original PDF page number**.
//!
//! Flow:
//! 1. `POST {job_url}` multipart `{file, model, pageRanges, optionalPayload}`
//! 2. `GET  {job_url}/{jobId}` until `data.state == "done"` or `"failed"`.
//!    Each poll surfaces `extractProgress.extractedPages / totalPages` via
//!    the supplied progress callback so the UI can show document-level
//!    progress instead of waiting on a single final event.
//! 3. `GET  data.resultUrl.jsonUrl` → JSONL of `{result:
//!    {layoutParsingResults:[{markdown:{text,...}}, ...]}}`. One line per
//!    requested page, in the order they appear in `requested_pages`.
//!
//! Page-mapping convention: we send `pageRanges` derived from a sorted /
//! deduped `requested_pages` list (`PageRangePlan` on the frontend already
//! enforces this), and Paddle returns lines in that same order — so line N
//! corresponds to `requested_pages[N]`. The mapping is preserved across
//! local PDF chunking too (Phase 5), since the chunk manifest will be
//! responsible for translating chunk-local page indices back to originals
//! before this module sees them.
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::config::PaddleDocumentOptions;
use crate::error::{AppError, AppResult};
use crate::ocr::paddle_json::{self, LayoutPage};

const PROVIDER: &str = "paddleocr";

/// One requested page's recognized text. `page` is the **original PDF
/// page number** (1-based), regardless of how many pages were actually
/// submitted to Paddle.
#[derive(Debug, Clone)]
pub struct DocPageResult {
    pub page: u32,
    pub text: String,
    pub layout: Option<LayoutPage>,
}

/// Progress callback signature: `(extracted_pages, total_pages, label)`.
/// `total_pages` is the count Paddle reports for the submitted file —
/// usually equal to `requested_pages.len()` but the API is authoritative.
pub type ProgressFn<'a> = &'a mut (dyn FnMut(u32, u32) + Send);

#[derive(Deserialize)]
struct Envelope<T> {
    #[serde(default)]
    code: i32,
    #[serde(default)]
    msg: Option<String>,
    data: T,
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
    #[serde(rename = "extractProgress", default)]
    extract_progress: Option<ExtractProgress>,
}

#[derive(Deserialize, Default)]
struct ResultUrl {
    #[serde(rename = "jsonUrl", default)]
    json_url: Option<String>,
}

#[derive(Deserialize, Default)]
struct ExtractProgress {
    #[serde(rename = "extractedPages", default)]
    extracted_pages: Option<u32>,
    #[serde(rename = "totalPages", default)]
    total_pages: Option<u32>,
}

fn is_api_code_retryable(code: i32) -> bool {
    matches!(code, 500 | 10010)
}

fn http_retryable(status: reqwest::StatusCode) -> bool {
    status.as_u16() == 429 || status.is_server_error()
}

fn ocr_err(stage: &str, msg: impl Into<String>, retryable: bool) -> AppError {
    AppError::Ocr {
        provider: format!("{PROVIDER}/document/{stage}"),
        message: msg.into(),
        retryable,
    }
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Build the optional payload used by Paddle's document-level OCR endpoint.
/// This is intentionally not shared with the cropped-block Paddle path:
/// these controls ask Paddle for richer layout metadata that only the
/// whole-file PDF flow and layout-PDF exporter consume.
pub fn document_payload(options: &PaddleDocumentOptions) -> serde_json::Value {
    let mut markdown_ignore_labels: Vec<&str> = Vec::new();
    if !options.include_header {
        markdown_ignore_labels.push("header");
    }
    if !options.include_footer {
        markdown_ignore_labels.push("footer");
    }
    if !options.include_page_number {
        markdown_ignore_labels.push("page_number");
    }
    if !options.include_aside_text {
        markdown_ignore_labels.push("aside_text");
    }
    if !options.include_header_image {
        markdown_ignore_labels.push("header_image");
    }
    if !options.include_footer_image {
        markdown_ignore_labels.push("footer_image");
    }
    if !options.include_footnote {
        markdown_ignore_labels.push("footnote");
    }

    serde_json::json!({
        "markdownIgnoreLabels": markdown_ignore_labels,
        "useDocOrientationClassify": options.use_doc_orientation_classify,
        "useDocUnwarping": options.use_doc_unwarping,
        "useLayoutDetection": options.use_layout_detection,
        "useChartRecognition": options.use_chart_recognition,
        "useSealRecognition": options.use_seal_recognition,
        "useOcrForImageBlock": options.use_ocr_for_image_block,
        "mergeTables": options.merge_tables,
        "relevelTitles": options.relevel_titles,
        "layoutShapeMode": options.layout_shape_mode,
        "promptLabel": options.prompt_label,
        "repetitionPenalty": options.repetition_penalty,
        "temperature": options.temperature,
        "topP": options.top_p,
        "minPixels": options.min_pixels,
        "maxPixels": options.max_pixels,
        "layoutNms": options.layout_nms,
        "restructurePages": options.restructure_pages,
    })
}

/// Compact a sorted page list into Paddle's `pageRanges` string format.
/// `1,2,3,5,7,8,9` → `"1-3,5,7-9"`. Input must be sorted ascending and
/// deduplicated — the frontend's `parsePageRangePlan` already guarantees
/// this, but we re-sort defensively.
pub fn pages_to_ranges_string(pages: &[u32]) -> String {
    if pages.is_empty() {
        return String::new();
    }
    let mut sorted = pages.to_vec();
    sorted.sort_unstable();
    sorted.dedup();

    let mut out = String::new();
    let mut i = 0;
    while i < sorted.len() {
        let start = sorted[i];
        let mut end = start;
        while i + 1 < sorted.len() && sorted[i + 1] == end + 1 {
            end = sorted[i + 1];
            i += 1;
        }
        if !out.is_empty() {
            out.push(',');
        }
        if start == end {
            out.push_str(&start.to_string());
        } else {
            out.push_str(&format!("{start}-{end}"));
        }
        i += 1;
    }
    out
}

#[allow(clippy::too_many_arguments)]
pub async fn recognize_document(
    client: &reqwest::Client,
    job_url: &str,
    token: &str,
    model: &str,
    file_path: PathBuf,
    file_mime: &str,
    file_name: &str,
    page_ranges: Option<String>,
    optional_payload: serde_json::Value,
    requested_pages: Vec<u32>,
    poll_interval: Duration,
    poll_timeout: Duration,
    cancel: &CancellationToken,
    on_progress: ProgressFn<'_>,
) -> AppResult<Vec<DocPageResult>> {
    if token.is_empty() {
        return Err(AppError::Config(
            "PaddleOCR：尚未配置 Token，请在设置中填入。".into(),
        ));
    }
    if requested_pages.is_empty() {
        return Err(AppError::Config("文档级 OCR 没有可识别的页面".into()));
    }
    let job_url = job_url.trim_end_matches('/');

    let file_bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| AppError::Internal(format!("read {}: {e}", file_path.display())))?;

    let job_id = submit(
        client,
        job_url,
        token,
        model,
        file_bytes,
        file_mime,
        file_name,
        page_ranges.as_deref(),
        &optional_payload,
    )
    .await?;

    let json_url = poll(
        client,
        job_url,
        token,
        &job_id,
        poll_interval,
        poll_timeout,
        cancel,
        on_progress,
    )
    .await?;

    let pages = fetch_jsonl(client, &json_url).await?;
    map_jsonl_pages_to_requested(pages, &requested_pages)
}

#[allow(clippy::too_many_arguments)]
async fn submit(
    client: &reqwest::Client,
    job_url: &str,
    token: &str,
    model: &str,
    file_bytes: Vec<u8>,
    file_mime: &str,
    file_name: &str,
    page_ranges: Option<&str>,
    optional_payload: &serde_json::Value,
) -> AppResult<String> {
    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(file_name.to_string())
        .mime_str(file_mime)
        .map_err(|e| AppError::Internal(format!("multipart mime: {e}")))?;
    let mut form = reqwest::multipart::Form::new()
        .text("model", model.to_string())
        .text("optionalPayload", optional_payload.to_string())
        .part("file", part);
    if let Some(ranges) = page_ranges {
        if !ranges.is_empty() {
            form = form.text("pageRanges", ranges.to_string());
        }
    }

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
    if env.code != 0 {
        return Err(ocr_err(
            "submit",
            format!("code {} {}", env.code, env.msg.unwrap_or_default()),
            is_api_code_retryable(env.code),
        ));
    }
    Ok(env.data.job_id)
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
    on_progress: ProgressFn<'_>,
) -> AppResult<String> {
    let url = format!("{job_url}/{job_id}");
    let start = Instant::now();
    let auth = format!("Bearer {token}");
    loop {
        if cancel.is_cancelled() {
            return Err(AppError::Cancelled("paddle document poll".into()));
        }
        if start.elapsed() > overall_timeout {
            return Err(ocr_err("poll", "timeout waiting for job to finish", false));
        }
        let resp = client
            .get(&url)
            .header("Authorization", &auth)
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
        if env.code != 0 {
            return Err(ocr_err(
                "poll",
                format!("code {} {}", env.code, env.msg.unwrap_or_default()),
                is_api_code_retryable(env.code),
            ));
        }
        if let Some(progress) = env.data.extract_progress.as_ref() {
            if let (Some(done), Some(total)) = (progress.extracted_pages, progress.total_pages) {
                on_progress(done, total);
            }
        }
        match env.data.state.as_str() {
            "done" => {
                let json_url = env
                    .data
                    .result_url
                    .and_then(|r| r.json_url)
                    .ok_or_else(|| {
                        ocr_err("poll", "done state missing resultUrl.jsonUrl", false)
                    })?;
                return Ok(json_url);
            }
            "failed" => {
                let msg = env.data.error_msg.unwrap_or_else(|| "unknown error".into());
                return Err(ocr_err("job", format!("job failed: {msg}"), false));
            }
            _ => {
                tokio::select! {
                    _ = tokio::time::sleep(interval) => {}
                    _ = cancel.cancelled() => {
                        return Err(AppError::Cancelled("paddle document poll".into()));
                    }
                }
            }
        }
    }
}

async fn fetch_jsonl(
    client: &reqwest::Client,
    json_url: &str,
) -> AppResult<Vec<serde_json::Value>> {
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

    let mut pages: Vec<serde_json::Value> = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|e| ocr_err("result", format!("jsonl line: {e}"), false))?;
        pages.push(parsed);
    }
    Ok(pages)
}

/// Zip JSONL pages back onto the original page numbers. If Paddle returns
/// fewer pages than requested we leave the tail empty rather than fail
/// outright — the caller decides whether to treat missing pages as errors
/// (the whole-file runner does, so the UI can show `[未识别]`). The JSONL
/// page payload is also normalized through the Paddle JSON importer so the
/// layout-rebuilt PDF exporter can consume the same `LayoutPage` model as
/// manual Paddle JSON imports.
fn map_jsonl_pages_to_requested(
    pages: Vec<serde_json::Value>,
    requested_pages: &[u32],
) -> AppResult<Vec<DocPageResult>> {
    let page_texts = pages.iter().map(jsonl_page_text).collect::<Vec<_>>();
    let import = paddle_json::analyze_value(serde_json::Value::Array(pages))?;
    let mut out: Vec<DocPageResult> = Vec::with_capacity(requested_pages.len());
    for (idx, page) in requested_pages.iter().enumerate() {
        let text = page_texts
            .get(idx)
            .filter(|text| !text.is_empty())
            .cloned()
            .or_else(|| import.page_texts.get(idx).map(|p| p.text.clone()))
            .unwrap_or_default();
        let layout = import.document.pages.get(idx).cloned().map(|mut layout| {
            layout.index = *page;
            layout
        });
        out.push(DocPageResult {
            page: *page,
            text,
            layout,
        });
    }
    Ok(out)
}

fn jsonl_page_text(page: &serde_json::Value) -> String {
    let results = page
        .get("result")
        .and_then(|r| r.get("layoutParsingResults"))
        .or_else(|| page.get("layoutParsingResults"))
        .and_then(|v| v.as_array());
    let Some(results) = results else {
        return String::new();
    };
    results
        .iter()
        .filter_map(|item| {
            item.get("markdown")
                .and_then(|m| m.get("text"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .collect::<Vec<_>>()
        .join("\n")
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

    fn write_temp_pdf(contents: &[u8]) -> tempfile::NamedTempFile {
        use std::io::Write;
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(contents).unwrap();
        f
    }

    fn default_payload() -> serde_json::Value {
        document_payload(&PaddleDocumentOptions::default())
    }

    #[test]
    fn pages_to_ranges_string_compacts_runs() {
        assert_eq!(pages_to_ranges_string(&[]), "");
        assert_eq!(pages_to_ranges_string(&[1]), "1");
        assert_eq!(pages_to_ranges_string(&[1, 2, 3]), "1-3");
        assert_eq!(
            pages_to_ranges_string(&[1, 2, 3, 5, 7, 8, 9, 12]),
            "1-3,5,7-9,12"
        );
    }

    #[test]
    fn pages_to_ranges_string_handles_unsorted_input() {
        // Defense in depth — the frontend already sorts, but a stray caller
        // shouldn't produce a malformed Paddle range.
        assert_eq!(pages_to_ranges_string(&[3, 1, 2, 5]), "1-3,5");
    }

    #[test]
    fn pages_to_ranges_string_dedupes() {
        assert_eq!(pages_to_ranges_string(&[1, 1, 2, 2, 3]), "1-3");
    }

    #[test]
    fn document_payload_uses_paddle_document_options() {
        let mut options = PaddleDocumentOptions::default();
        options.include_header = false;
        options.include_header_image = false;
        options.use_chart_recognition = true;
        options.layout_shape_mode = "polygon".into();
        options.prompt_label = "table".into();
        options.temperature = 0.2;

        let payload = document_payload(&options);
        assert_eq!(payload["useChartRecognition"], true);
        assert_eq!(payload["layoutShapeMode"], "polygon");
        assert_eq!(payload["promptLabel"], "table");
        assert_eq!(payload["temperature"], 0.2);
        assert_eq!(
            payload["markdownIgnoreLabels"],
            json!(["header", "header_image", "footer_image"])
        );
    }

    #[test]
    fn map_jsonl_pages_to_requested_zips_pages_with_originals() {
        let pages = vec![
            json!({ "result": { "layoutParsingResults": [
                { "markdown": { "text": "a" }, "block_bbox": [0, 0, 10, 10] }
            ]}}),
            json!({ "result": { "layoutParsingResults": [
                { "markdown": { "text": "b" }, "block_bbox": [0, 0, 20, 20] }
            ]}}),
            json!({ "result": { "layoutParsingResults": [
                { "markdown": { "text": "c" }, "block_bbox": [0, 0, 30, 30] }
            ]}}),
        ];
        let mapped = map_jsonl_pages_to_requested(pages, &[1, 5, 8]).unwrap();
        assert_eq!(mapped.len(), 3);
        assert_eq!(mapped[0].page, 1);
        assert_eq!(mapped[0].text, "a");
        assert_eq!(mapped[1].page, 5);
        assert_eq!(mapped[1].text, "b");
        assert_eq!(mapped[1].layout.as_ref().unwrap().index, 5);
        assert_eq!(mapped[1].layout.as_ref().unwrap().blocks.len(), 1);
        assert_eq!(mapped[2].page, 8);
        assert_eq!(mapped[2].text, "c");
    }

    #[test]
    fn map_jsonl_pages_to_requested_pads_missing_tail_with_empty() {
        let pages = vec![json!({ "result": { "layoutParsingResults": [
            { "markdown": { "text": "only" }, "block_bbox": [0, 0, 10, 10] }
        ]}})];
        let mapped = map_jsonl_pages_to_requested(pages, &[1, 2, 3]).unwrap();
        assert_eq!(mapped[0].text, "only");
        assert_eq!(mapped[1].text, "");
        assert!(mapped[1].layout.is_none());
        assert_eq!(mapped[2].text, "");
    }

    #[tokio::test]
    async fn happy_path_submits_polls_and_maps_pages() {
        let server = MockServer::start().await;
        let base = server.uri();
        let json_url = format!("{base}/doc-result.jsonl");

        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .and(header("Authorization", "Bearer tk"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "jobId": "doc-job-1" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v2/ocr/jobs/doc-job-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0,
                "data": {
                    "state": "done",
                    "resultUrl": { "jsonUrl": json_url.clone() },
                    "extractProgress": { "extractedPages": 3, "totalPages": 3 }
                }
            })))
            .mount(&server)
            .await;
        let jsonl = [
            json!({ "result": { "layoutParsingResults": [
                { "markdown": { "text": "page A body" } }
            ]}}),
            json!({ "result": { "layoutParsingResults": [
                { "markdown": { "text": "page B body" } },
                { "markdown": { "text": "" } },
                { "markdown": { "text": "page B footer" } }
            ]}}),
            json!({ "result": { "layoutParsingResults": [
                { "markdown": { "text": "page C body" } }
            ]}}),
        ]
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        Mock::given(method("GET"))
            .and(path("/doc-result.jsonl"))
            .respond_with(ResponseTemplate::new(200).set_body_string(jsonl))
            .mount(&server)
            .await;

        let pdf = write_temp_pdf(b"%PDF-1.4 test");
        let cancel = never_cancelled();
        let mut events: Vec<(u32, u32)> = Vec::new();
        let mut on_progress = |done: u32, total: u32| {
            events.push((done, total));
        };

        let out = recognize_document(
            &reqwest::Client::new(),
            &format!("{base}/api/v2/ocr/jobs"),
            "tk",
            "PaddleOCR-VL-1.5",
            pdf.path().to_path_buf(),
            "application/pdf",
            "x.pdf",
            Some("1-2,5".to_string()),
            default_payload(),
            vec![1, 2, 5],
            FAST_POLL,
            POLL_CAP,
            &cancel,
            &mut on_progress,
        )
        .await
        .unwrap();

        assert_eq!(out.len(), 3);
        assert_eq!(out[0].page, 1);
        assert_eq!(out[0].text, "page A body");
        assert_eq!(out[1].page, 2);
        assert_eq!(out[1].text, "page B body\npage B footer");
        assert_eq!(out[2].page, 5);
        assert_eq!(out[2].text, "page C body");
        assert!(events.last() == Some(&(3, 3)));
    }

    #[tokio::test]
    async fn cancellation_short_circuits_poll() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "jobId": "stuck-doc" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v2/ocr/jobs/stuck-doc"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "state": "pending" }
            })))
            .mount(&server)
            .await;

        let pdf = write_temp_pdf(b"%PDF-1.4");
        let cancel = CancellationToken::new();
        let cancel_clone = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel_clone.cancel();
        });
        let mut on_progress = |_: u32, _: u32| {};
        let started = Instant::now();
        let err = recognize_document(
            &reqwest::Client::new(),
            &format!("{}/api/v2/ocr/jobs", server.uri()),
            "tk",
            "PaddleOCR-VL-1.5",
            pdf.path().to_path_buf(),
            "application/pdf",
            "x.pdf",
            None,
            default_payload(),
            vec![1],
            Duration::from_secs(5),
            Duration::from_secs(30),
            &cancel,
            &mut on_progress,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Cancelled(_)));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn failed_state_returns_non_retryable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "data": { "jobId": "doc-fail" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v2/ocr/jobs/doc-fail"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0,
                "data": { "state": "failed", "errorMsg": "页数超出限制" }
            })))
            .mount(&server)
            .await;

        let pdf = write_temp_pdf(b"%PDF-1.4");
        let cancel = never_cancelled();
        let mut on_progress = |_: u32, _: u32| {};
        let err = recognize_document(
            &reqwest::Client::new(),
            &format!("{}/api/v2/ocr/jobs", server.uri()),
            "tk",
            "",
            pdf.path().to_path_buf(),
            "application/pdf",
            "x.pdf",
            None,
            default_payload(),
            vec![1],
            FAST_POLL,
            POLL_CAP,
            &cancel,
            &mut on_progress,
        )
        .await
        .unwrap_err();
        assert!(!err.is_retryable());
        match err {
            AppError::Ocr { message, .. } => assert!(message.contains("页数超出限制")),
            other => panic!("expected Ocr, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn submit_5xx_is_retryable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/ocr/jobs"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let pdf = write_temp_pdf(b"%PDF-1.4");
        let cancel = never_cancelled();
        let mut on_progress = |_: u32, _: u32| {};
        let err = recognize_document(
            &reqwest::Client::new(),
            &format!("{}/api/v2/ocr/jobs", server.uri()),
            "tk",
            "",
            pdf.path().to_path_buf(),
            "application/pdf",
            "x.pdf",
            None,
            default_payload(),
            vec![1],
            FAST_POLL,
            POLL_CAP,
            &cancel,
            &mut on_progress,
        )
        .await
        .unwrap_err();
        assert!(err.is_retryable());
    }

    #[tokio::test]
    async fn missing_token_returns_config_error() {
        let pdf = write_temp_pdf(b"%PDF-1.4");
        let cancel = never_cancelled();
        let mut on_progress = |_: u32, _: u32| {};
        let err = recognize_document(
            &reqwest::Client::new(),
            "https://example.invalid/api/v2/ocr/jobs",
            "",
            "",
            pdf.path().to_path_buf(),
            "application/pdf",
            "x.pdf",
            None,
            default_payload(),
            vec![1],
            FAST_POLL,
            POLL_CAP,
            &cancel,
            &mut on_progress,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Config(_)));
    }
}
