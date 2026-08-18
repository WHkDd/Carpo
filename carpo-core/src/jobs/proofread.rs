//! LLM proofread job runner.
//!
//! The lightest of the three runners: proofreading is a text → text pass, so
//! there is no PDF rendering, no page loader, no chunking. Each unit (a page
//! in whole-file mode, an article in grouped mode) is one chat call; the
//! response is parsed into suggestions and every suggestion is anchor-
//! validated against its source text before it is reported back. The shared
//! `CancellationToken` threads through the chat call exactly as in the OCR
//! runners, so a user cancel aborts the network request, not the next poll.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{JobEventKind, ProgressStage};
use crate::config::{self, NonSecretSettings, Provider};
use crate::error::{AppError, AppResult};
use crate::jobs::grouped::secret_key_for_provider;
use crate::ocr::proofread::{anchor_suggestions, parse_suggestions, ProofreadSuggestion};
use crate::ocr::{self};
use crate::state::AppState;

/// One text unit to proofread. `key` is an opaque identifier supplied by the
/// frontend (`page:12` or `article:a_xxx`) and echoed back untouched — the
/// runner never interprets it.
#[derive(Debug, Clone, Deserialize)]
pub struct ProofreadUnit {
    pub key: String,
    pub text: String,
    /// Scans of the original this text was transcribed from, as raw base64
    /// JPEG **without** a `data:` prefix (the wrapper is added in
    /// [`crate::ocr::openai::chat_text`], so the mime type is ours, not the
    /// caller's). Normally one image; a grouped article that runs across a
    /// page break contributes one per page it touches.
    ///
    /// `Vec` rather than `Option<String>` because the cap that matters is on
    /// *images per request*, and the frontend cannot always reduce a unit to
    /// a single picture. Empty is legal and means "text only": capture can
    /// fail (a bitmap not yet rendered, a cropping error) and a proofread
    /// that still runs on the text beats one that refuses to start.
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProofreadRequest {
    #[allow(dead_code)]
    pub file_id: String,
    pub units: Vec<ProofreadUnit>,
    /// Snapshot of the settings the frontend *confirmed* when it started the
    /// job. When present it overrides the on-disk configuration: the model
    /// the user saw is the model that runs, so the timing of the settings
    /// write-back is off the correctness path entirely. `validate` and `run`
    /// both resolve against the merged view (see `effective_settings`).
    #[serde(default)]
    pub provider: Option<Provider>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
}

/// The settings a request actually runs under: the loaded configuration with
/// the request's snapshot written over the proofread fields. The same merge
/// feeds `validate` and `run`, so what gets checked is what gets executed.
fn effective_settings(req: &ProofreadRequest, settings: &NonSecretSettings) -> NonSecretSettings {
    let mut effective = settings.clone();
    if let Some(provider) = req.provider {
        effective.proofread_provider = Some(provider);
    }
    if let Some(model) = req.model.clone() {
        effective.proofread_model = model;
    }
    if let Some(prompt) = req.prompt.clone() {
        effective.proofread_prompt = prompt;
    }
    effective
}

#[derive(Debug, Clone, Serialize)]
pub struct ProofreadResultPayload {
    pub key: String,
    pub suggestions: Vec<ProofreadSuggestion>,
    /// Suggestions the model sent but anchor validation dropped. Surfaced so
    /// the user can see the filter working instead of wondering where the
    /// rest of the list went.
    pub discarded: u32,
    /// The model this unit was proofread with — visible in the review view.
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProofreadErrorPayload {
    pub key: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
struct ProgressEvent {
    job_id: String,
    done: u32,
    total: u32,
    label: String,
    stage: ProgressStage,
}

#[derive(Debug, Clone, Serialize)]
struct DoneEvent {
    job_id: String,
    results: Vec<ProofreadResultPayload>,
    errors: Vec<ProofreadErrorPayload>,
    cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
struct ErrorEvent {
    job_id: String,
    error: String,
}

pub fn spawn(state: Arc<AppState>, req: ProofreadRequest, job_id: Uuid, token: CancellationToken) {
    spawn_inner(state, req, job_id, token, None);
}

pub fn spawn_with_settings(
    state: Arc<AppState>,
    req: ProofreadRequest,
    job_id: Uuid,
    token: CancellationToken,
    settings: NonSecretSettings,
) {
    spawn_inner(state, req, job_id, token, Some(settings));
}

fn spawn_inner(
    state: Arc<AppState>,
    req: ProofreadRequest,
    job_id: Uuid,
    token: CancellationToken,
    settings: Option<NonSecretSettings>,
) {
    if let Some(settings) = settings.as_ref() {
        crate::i18n::set_language(settings.language.unwrap_or_default());
    }
    tokio::spawn(async move {
        let outcome = run(Arc::clone(&state), req, job_id, token, settings).await;
        state.jobs.remove(job_id);
        if let Err(e) = outcome {
            log::error!("proofread job {job_id} crashed: {e}");
            state.events.emit(
                JobEventKind::Error,
                ErrorEvent {
                    job_id: job_id.to_string(),
                    error: e.to_string(),
                },
            );
        }
    });
}

async fn run(
    state: Arc<AppState>,
    req: ProofreadRequest,
    job_id: Uuid,
    token: CancellationToken,
    settings: Option<NonSecretSettings>,
) -> AppResult<()> {
    let settings = match settings {
        Some(settings) => settings,
        None => config::load(&state.data_dir)?,
    };
    // The request's snapshot wins over the disk: `validate` already checked
    // exactly this merged view, and running anything else would silently
    // diverge from what the user picked in the menu.
    let settings = effective_settings(&req, &settings);
    let provider = ocr::resolve_proofread_provider(&settings);
    let secret_key = secret_key_for_provider(provider);
    let secret = state.secrets.get(secret_key).await?;
    let job_id_str = job_id.to_string();
    let total = req.units.len() as u32;

    state.events.emit(
        JobEventKind::Progress,
        ProgressEvent {
            job_id: job_id_str.clone(),
            done: 0,
            total,
            label: crate::trf!(
                "准备校对 · 共 {} 个单元",
                "Preparing proofread · {} units",
                total
            ),
            stage: ProgressStage::ProofreadRunning {
                index: 0,
                count: total,
            },
        },
    );

    let client = state.http.clone();
    let settings = Arc::new(settings);
    let secret_arc: Arc<Option<String>> = Arc::new(secret);
    let done_counter = Arc::new(AtomicU32::new(0));
    let model = ocr::resolve_proofread_model(&settings);

    let outcomes: Vec<UnitOutcome> = stream::iter(req.units.into_iter().enumerate())
        .map(|(idx, unit)| {
            run_one_unit(
                Arc::clone(&state),
                client.clone(),
                token.clone(),
                job_id_str.clone(),
                total,
                Arc::clone(&settings),
                Arc::clone(&secret_arc),
                Arc::clone(&done_counter),
                model.clone(),
                unit,
                idx + 1,
            )
        })
        .buffer_unordered(ocr::concurrency_for(provider))
        .collect()
        .await;

    let mut results: Vec<ProofreadResultPayload> = Vec::new();
    let mut errors: Vec<ProofreadErrorPayload> = Vec::new();
    let mut cancelled = false;
    for outcome in outcomes {
        match outcome {
            UnitOutcome::Done {
                key,
                suggestions,
                discarded,
                model,
            } => results.push(ProofreadResultPayload {
                key,
                suggestions,
                discarded,
                model,
            }),
            UnitOutcome::Failed { key, message } => {
                errors.push(ProofreadErrorPayload { key, message })
            }
            UnitOutcome::Cancelled => cancelled = true,
        }
    }

    state.events.emit(
        JobEventKind::Done,
        DoneEvent {
            job_id: job_id_str,
            results,
            errors,
            cancelled,
        },
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_one_unit(
    state: Arc<AppState>,
    client: reqwest::Client,
    token: CancellationToken,
    job_id_str: String,
    total: u32,
    settings: Arc<NonSecretSettings>,
    secret: Arc<Option<String>>,
    done_counter: Arc<AtomicU32>,
    model: String,
    unit: ProofreadUnit,
    index: usize,
) -> UnitOutcome {
    if token.is_cancelled() {
        return UnitOutcome::Cancelled;
    }

    let cur_done = done_counter.load(Ordering::SeqCst);
    state.events.emit(
        JobEventKind::Progress,
        ProgressEvent {
            job_id: job_id_str.clone(),
            done: cur_done,
            total,
            label: crate::trf!(
                "校对中 · 第{}/{}单元",
                "Proofreading · unit {}/{}",
                index,
                total
            ),
            stage: ProgressStage::ProofreadRunning {
                index: index as u32,
                count: total,
            },
        },
    );

    let secret_ref: Option<&str> = secret.as_ref().as_deref();
    let chat_call = ocr::chat_with_retry(
        &client,
        &settings,
        secret_ref,
        &unit.text,
        &unit.images,
        &token,
    );
    let raw = tokio::select! {
        r = chat_call => r,
        _ = token.cancelled() => {
            return UnitOutcome::Cancelled;
        }
    };

    match raw {
        Ok(raw) => match parse_suggestions(&raw) {
            Ok(suggestions) => {
                let (anchored, discarded) = anchor_suggestions(&unit.text, suggestions);
                let n = done_counter.fetch_add(1, Ordering::SeqCst) + 1;
                state.events.emit(
                    JobEventKind::Progress,
                    ProgressEvent {
                        job_id: job_id_str,
                        done: n,
                        total,
                        label: crate::trf!("完成 · 第{}/{}单元", "Done · unit {}/{}", index, total),
                        stage: ProgressStage::ProofreadRunning {
                            index: index as u32,
                            count: total,
                        },
                    },
                );
                UnitOutcome::Done {
                    key: unit.key,
                    suggestions: anchored,
                    discarded,
                    model,
                }
            }
            Err(e) => UnitOutcome::Failed {
                key: unit.key,
                message: e.to_string(),
            },
        },
        Err(AppError::Cancelled(_)) => UnitOutcome::Cancelled,
        Err(e) => UnitOutcome::Failed {
            key: unit.key,
            message: crate::trf!("校对失败: {}", "Proofread failed: {}", e),
        },
    }
}

enum UnitOutcome {
    Done {
        key: String,
        suggestions: Vec<ProofreadSuggestion>,
        discarded: u32,
        model: String,
    },
    Failed {
        key: String,
        message: String,
    },
    Cancelled,
}

/// Most units one request may carry. A long PDF's page count and a newspaper
/// page's article count are both far below this; anything above is a caller
/// multiplying billable calls, not a document.
pub const MAX_PROOFREAD_UNITS: usize = 200;
/// Most characters one unit may carry. A densely set vertical Chinese page runs
/// 3k–8k characters, and the response side is already capped at
/// [`crate::ocr::proofread::PROOFREAD_MAX_TOKENS`].
pub const MAX_UNIT_CHARS: usize = 20_000;
/// Most characters the proofread prompt may carry. Capped separately because it
/// is re-sent with **every** unit, and `PUT /api/settings` (unauthenticated on
/// the server today) can write it to any length.
pub const MAX_PROMPT_CHARS: usize = 8_000;
/// Ceiling on one request's total outbound characters, counted as
/// `Σ unit_chars + unit_count × prompt_chars`. Counting only the body text
/// would miss the multiplication: 200 tiny units with a 8k prompt is 1.6M
/// characters on the wire, not the 200 the bodies suggest.
pub const MAX_BUDGET_CHARS: usize = 400_000;
/// Model ids are interpolated into request paths and logs, so bound the length
/// and refuse control characters.
pub const MAX_MODEL_CHARS: usize = 200;
/// Most page images one request may carry, counted across all units. Every
/// image is billed input tokens on top of the text, so this is the cost
/// ceiling as much as the size ceiling: a newspaper page holds well under 20
/// articles, and the frontend refuses to send more rather than silently
/// splitting the batch.
pub const MAX_IMAGES: usize = 20;
/// Largest single base64 image, in bytes of encoded payload. The desktop
/// encodes JPEG at a 2000px long edge, which lands around 300KB–1MB encoded;
/// 4MB leaves room for a dense colour scan without accepting a video.
pub const MAX_IMAGE_B64_BYTES: usize = 4 * 1024 * 1024;
/// Ceiling on one request's total encoded image payload. Bounds the JSON body
/// independently of [`MAX_IMAGES`], which cannot on its own stop 20 images
/// that are each at the single-image limit.
pub const MAX_IMAGES_TOTAL_B64_BYTES: usize = 40 * 1024 * 1024;

/// Rejects anything that is not a bare base64 payload.
///
/// A `data:` prefix is refused rather than tolerated: the mime type is chosen
/// by [`crate::ocr::openai::chat_text`], and accepting a caller-supplied one
/// would let an untrusted server caller name any type it liked. The charset
/// check is cheap (no decode, no allocation) and rejects the prefix on its
/// own; the explicit `data:` test exists only so the error names the actual
/// mistake instead of pointing at a stray colon.
fn check_image_b64(key: &str, image: &str) -> AppResult<()> {
    if image.is_empty() {
        return Err(AppError::Config(crate::trf!(
            "校对单元 {} 的原图数据为空。",
            "A page image for proofread unit {} is empty.",
            key
        )));
    }
    if image.len() > MAX_IMAGE_B64_BYTES {
        return Err(AppError::Config(crate::trf!(
            "校对单元 {} 的原图过大：{} 字节，上限 {} 字节。",
            "A page image for proofread unit {} is too large: {} bytes (limit {}).",
            key,
            image.len(),
            MAX_IMAGE_B64_BYTES
        )));
    }
    if image.starts_with("data:") {
        return Err(AppError::Config(crate::trf!(
            "校对单元 {} 的原图应为纯 base64，不要带 data: 前缀。",
            "A page image for proofread unit {} must be bare base64, without a data: prefix.",
            key
        )));
    }
    if !image
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
    {
        return Err(AppError::Config(crate::trf!(
            "校对单元 {} 的原图不是合法的 base64 数据。",
            "A page image for proofread unit {} is not valid base64.",
            key
        )));
    }
    Ok(())
}

/// Rejects a proofread request that must not be started. Two kinds of check
/// live here: *it will never work* (no chat-capable provider, no model, empty
/// text) and *it is too big to be a real document* (the caps above).
///
/// The size caps matter most on `carpo-server`, where the units are supplied
/// verbatim by an unauthenticated caller and each one becomes a paid LLM call.
/// All character counts use `chars().count()`, never `len()`: a byte count
/// would cut a Chinese page off at roughly a third of its real length.
///
/// Runs *before* [`crate::jobs::JobRegistry::try_register`] at both entry
/// points, so an oversized request is refused (400) rather than queued (429) —
/// a request that is invalid on its face has no business waiting for capacity.
pub fn validate(req: &ProofreadRequest, settings: &NonSecretSettings) -> AppResult<()> {
    // The snapshot, when the request carries one, is what will actually run —
    // every limit below must apply to that merged view, not to the on-disk
    // value the request may already have superseded.
    let settings = &effective_settings(req, settings);
    if req.units.is_empty() {
        return Err(AppError::Config(
            crate::tr!("没有可校对的文本单元", "No text units to proofread").into(),
        ));
    }
    if req.units.len() > MAX_PROOFREAD_UNITS {
        return Err(AppError::Config(crate::trf!(
            "校对单元过多：{} 个，上限 {} 个。",
            "Too many proofread units: {} (limit {}).",
            req.units.len(),
            MAX_PROOFREAD_UNITS
        )));
    }
    let mut seen: HashSet<&str> = HashSet::with_capacity(req.units.len());
    let mut unit_chars_total: usize = 0;
    let mut image_count: usize = 0;
    let mut image_bytes_total: usize = 0;
    for unit in &req.units {
        if unit.key.is_empty() {
            return Err(AppError::Config(
                crate::tr!("校对单元缺少标识", "A proofread unit is missing its key").into(),
            ));
        }
        if !seen.insert(unit.key.as_str()) {
            // Two units for one target would race each other's write-back.
            return Err(AppError::Config(crate::trf!(
                "校对单元标识重复：{}",
                "Duplicate proofread unit key: {}",
                unit.key
            )));
        }
        if unit.text.trim().is_empty() {
            return Err(AppError::Config(
                crate::tr!("校对单元文本为空", "A proofread unit has no text").into(),
            ));
        }
        let chars = unit.text.chars().count();
        if chars > MAX_UNIT_CHARS {
            return Err(AppError::Config(crate::trf!(
                "校对单元 {} 文本过长：{} 字，上限 {} 字。",
                "Proofread unit {} is too long: {} characters (limit {}).",
                unit.key,
                chars,
                MAX_UNIT_CHARS
            )));
        }
        unit_chars_total += chars;

        for image in &unit.images {
            check_image_b64(&unit.key, image)?;
            image_count += 1;
            image_bytes_total = image_bytes_total.saturating_add(image.len());
        }
        if image_count > MAX_IMAGES {
            return Err(AppError::Config(crate::trf!(
                "本次校对的原图过多：超过上限 {} 张。请缩小范围后分批校对。",
                "Too many page images in this proofread request: over the limit of {}. Narrow the selection and proofread in batches.",
                MAX_IMAGES
            )));
        }
        if image_bytes_total > MAX_IMAGES_TOTAL_B64_BYTES {
            return Err(AppError::Config(crate::trf!(
                "本次校对的原图总量过大：超过上限 {} 字节。请缩小范围后分批校对。",
                "The page images in this proofread request are too large in total: over the limit of {} bytes. Narrow the selection and proofread in batches.",
                MAX_IMAGES_TOTAL_B64_BYTES
            )));
        }
    }
    let provider = ocr::resolve_proofread_provider(settings);
    if provider == Provider::Paddleocr {
        return Err(AppError::Config(
            crate::tr!(
                "校对需要支持对话的提供商（OpenAI / OpenRouter / OpenAI-Compatible）；PaddleOCR 仅用于识别。",
                "Proofreading needs a chat-capable provider (OpenAI / OpenRouter / OpenAI-Compatible); PaddleOCR is recognition-only."
            )
            .into(),
        ));
    }
    let model = ocr::resolve_proofread_model(settings);
    if model.is_empty() {
        return Err(AppError::Config(
            crate::tr!(
                "尚未配置校对模型，请在设置中填入。",
                "No proofread model configured — set one in Settings."
            )
            .into(),
        ));
    }
    if model.chars().count() > MAX_MODEL_CHARS || model.chars().any(char::is_control) {
        return Err(AppError::Config(crate::trf!(
            "校对模型名称不合法（上限 {} 字，且不得含控制字符）。",
            "Invalid proofread model id (limit {} characters, no control characters).",
            MAX_MODEL_CHARS
        )));
    }
    if provider == Provider::OpenaiCompatible {
        // Fail fast on the endpoint instead of letting every unit discover it
        // separately at send time. `ocr::recognize` / `ocr::chat` screen the same
        // value again under the process's admission policy — this is the early
        // copy, not the only one.
        if settings.openai_compatible_base_url.is_empty() {
            return Err(AppError::Config(
                crate::tr!(
                    "OpenAI-Compatible：尚未配置 Base URL，请在设置中填入。",
                    "OpenAI-Compatible: no base URL configured — set one in Settings."
                )
                .into(),
            ));
        }
        ocr::base_url::check(
            &settings.openai_compatible_base_url,
            ocr::base_url::policy(),
        )?;
    }

    let prompt_chars = ocr::resolve_proofread_prompt(settings).chars().count();
    if prompt_chars > MAX_PROMPT_CHARS {
        return Err(AppError::Config(crate::trf!(
            "校对提示词过长：{} 字，上限 {} 字。",
            "Proofread prompt is too long: {} characters (limit {}).",
            prompt_chars,
            MAX_PROMPT_CHARS
        )));
    }
    // The prompt rides along with every single unit, so the budget is the sum
    // of the bodies *plus* the prompt once per unit.
    let budget = unit_chars_total.saturating_add(req.units.len().saturating_mul(prompt_chars));
    if budget > MAX_BUDGET_CHARS {
        return Err(AppError::Config(crate::trf!(
            "本次校对的总字符数过大：{}（正文 {} + 提示词 {} × {} 个单元），上限 {}。",
            "This proofread request is too large: {} characters (text {} + prompt {} × {} units), limit {}.",
            budget,
            unit_chars_total,
            prompt_chars,
            req.units.len(),
            MAX_BUDGET_CHARS
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::OcrProfile;
    use crate::secrets::{SecretFuture, SecretKey, SecretProvider};
    use crate::state::AppState;
    use serde_json::{json, Value};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    fn settings_with(
        provider: Provider,
        proofread_provider: Option<Provider>,
    ) -> NonSecretSettings {
        NonSecretSettings {
            provider,
            ocr_profile: OcrProfile::Standard,
            language: Some(crate::i18n::Language::Zh),
            ocr_prompt: String::new(),
            paddle_url: String::new(),
            paddle_model: String::new(),
            paddle_document_options: config::PaddleDocumentOptions::default(),
            openai_model: "gpt-4o".into(),
            openrouter_model: "google/gemini-2.5-flash".into(),
            openai_compatible_base_url: String::new(),
            openai_compatible_model: String::new(),
            proofread_provider,
            proofread_model: String::new(),
            proofread_prompt: String::new(),
        }
    }

    fn unit(key: &str, text: &str) -> ProofreadUnit {
        ProofreadUnit {
            key: key.into(),
            text: text.into(),
            images: Vec::new(),
        }
    }

    fn unit_with_images(key: &str, images: Vec<String>) -> ProofreadUnit {
        ProofreadUnit {
            key: key.into(),
            text: "本埠新聞".into(),
            images,
        }
    }

    /// Legal base64 of the requested encoded length (a multiple of 4, so no
    /// padding games are needed to hit an exact byte count).
    fn b64(len: usize) -> String {
        "QUJD".repeat(len / 4)
    }

    struct FixedSecret;

    impl SecretProvider for FixedSecret {
        fn get<'a>(&'a self, _key: SecretKey) -> SecretFuture<'a> {
            Box::pin(async { Ok(Some("sk-test".to_string())) })
        }
    }

    /// The whole runner, once, with an image attached: request assembly,
    /// prompt appendix, response parsing and anchor validation.
    ///
    /// The unit tests above each cover one link — that `validate` counts
    /// images, that `chat_text` shapes the parts array, that the appendix is
    /// appended. None of them proves those links are *connected*: that a
    /// `ProofreadUnit.images` set by the frontend actually reaches the wire,
    /// under the appendix, with the model's reply anchored back to the text.
    /// This is the seam where a missed argument would go unnoticed, because
    /// every part still passes its own test.
    #[tokio::test]
    async fn run_sends_the_image_with_the_appendix_and_anchors_the_reply() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(|req: &Request| {
                let body: Value = serde_json::from_slice(&req.body).unwrap();
                let messages = body["messages"].as_array().unwrap();
                let system = messages[0]["content"].as_str().unwrap();
                let user = messages[1]["content"].as_array().unwrap();

                // The appendix rides at the *end* of the system prompt, after
                // whatever the user configured. `garble` is in both language
                // versions, so this does not depend on the process language.
                assert!(
                    system.starts_with("只修 OCR 误识") && system.contains("garble"),
                    "system prompt lost the appendix or reordered it: {system}"
                );
                // Image first, then the text — one `image_url` part carrying
                // the base64 the unit supplied, wrapped as a jpeg data URL by
                // the backend rather than by the caller.
                assert_eq!(user[0]["type"], "image_url");
                assert_eq!(
                    user[0]["image_url"]["url"],
                    "data:image/jpeg;base64,QUJD"
                );
                assert_eq!(user[1]["type"], "text");
                assert_eq!(user[1]["text"], "本埠新聞，巳於昨日到達。");

                ResponseTemplate::new(200).set_body_json(json!({
                    "choices": [{
                        "message": { "content": "[{\"before\":\"巳\",\"after\":\"已\",\"context_before\":\"本埠新聞，\",\"category\":\"charform\",\"confidence\":0.9,\"reason\":\"形近字\"}]" },
                        "finish_reason": "stop"
                    }]
                }))
            })
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let Ok(state) = AppState::new(dir.path().to_path_buf(), Arc::new(FixedSecret)) else {
            eprintln!(
                "skipping run_sends_the_image_with_the_appendix_and_anchors_the_reply: pdfium library is not available"
            );
            return;
        };
        let state = Arc::new(state);

        let mut settings = settings_with(Provider::OpenaiCompatible, None);
        settings.openai_compatible_base_url = server.uri();
        settings.proofread_model = "local-vision".into();
        settings.proofread_prompt = "只修 OCR 误识".into();

        let req = ProofreadRequest {
            file_id: "f1".into(),
            units: vec![ProofreadUnit {
                key: "page:1".into(),
                text: "本埠新聞，巳於昨日到達。".into(),
                images: vec!["QUJD".into()],
            }],
            provider: None,
            model: None,
            prompt: None,
        };
        // The same admission check the entry points run before spawning.
        validate(&req, &settings).unwrap();

        let job_id = Uuid::new_v4();
        run(
            Arc::clone(&state),
            req,
            job_id,
            CancellationToken::new(),
            Some(settings),
        )
        .await
        .unwrap();

        let done = state
            .events
            .recent(&job_id.to_string())
            .expect("the runner emitted no terminal event");
        let results = done.payload["results"].as_array().unwrap();
        assert_eq!(done.payload["errors"].as_array().unwrap().len(), 0);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["key"], "page:1");
        assert_eq!(results[0]["model"], "local-vision");
        let suggestions = results[0]["suggestions"].as_array().unwrap();
        assert_eq!(suggestions.len(), 1, "the anchored suggestion was dropped");
        assert_eq!(suggestions[0]["before"], "巳");
        assert_eq!(suggestions[0]["after"], "已");
    }

    /// The text-only fallback the capture path degrades to. Same runner, no
    /// images: the request must go back to a bare string body, and the
    /// appendix must not claim there is an attachment.
    #[tokio::test]
    async fn run_without_images_sends_no_attachment_and_no_appendix() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(|req: &Request| {
                let body: Value = serde_json::from_slice(&req.body).unwrap();
                let messages = body["messages"].as_array().unwrap();
                assert_eq!(messages[0]["content"], "只修 OCR 误识");
                assert_eq!(messages[1]["content"], "本埠新聞。");
                ResponseTemplate::new(200).set_body_json(json!({
                    "choices": [{ "message": { "content": "[]" }, "finish_reason": "stop" }]
                }))
            })
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let Ok(state) = AppState::new(dir.path().to_path_buf(), Arc::new(FixedSecret)) else {
            eprintln!(
                "skipping run_without_images_sends_no_attachment_and_no_appendix: pdfium library is not available"
            );
            return;
        };
        let state = Arc::new(state);

        let mut settings = settings_with(Provider::OpenaiCompatible, None);
        settings.openai_compatible_base_url = server.uri();
        settings.proofread_model = "local-text".into();
        settings.proofread_prompt = "只修 OCR 误识".into();

        let job_id = Uuid::new_v4();
        run(
            Arc::clone(&state),
            ProofreadRequest {
                file_id: "f1".into(),
                units: vec![unit("page:1", "本埠新聞。")],
                provider: None,
                model: None,
                prompt: None,
            },
            job_id,
            CancellationToken::new(),
            Some(settings),
        )
        .await
        .unwrap();

        let done = state.events.recent(&job_id.to_string()).unwrap();
        assert_eq!(done.payload["errors"].as_array().unwrap().len(), 0);
        assert_eq!(done.payload["results"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn validate_rejects_empty_units() {
        let req = req_with(vec![]);
        assert!(validate(&req, &settings_with(Provider::Openai, None)).is_err());
    }

    #[test]
    fn validate_rejects_empty_text_or_key() {
        let settings = settings_with(Provider::Openai, None);
        let req = req_with(vec![unit("", "文本")]);
        assert!(validate(&req, &settings).is_err());
        let req = req_with(vec![unit("page:1", "   ")]);
        assert!(validate(&req, &settings).is_err());
    }

    #[test]
    fn validate_passes_for_chat_provider() {
        let req = req_with(vec![unit("page:1", "本埠新聞")]);
        assert!(validate(&req, &settings_with(Provider::Openai, None)).is_ok());
        // OCR stays on Paddle; proofread explicitly moves to OpenRouter.
        assert!(validate(
            &req,
            &settings_with(Provider::Paddleocr, Some(Provider::Openrouter))
        )
        .is_ok());
    }

    #[test]
    fn validate_rejects_paddle_even_when_following_ocr_provider() {
        let req = req_with(vec![unit("page:1", "本埠新聞")]);
        // Following the OCR provider lands on Paddle → rejected.
        let err = validate(&req, &settings_with(Provider::Paddleocr, None)).unwrap_err();
        match err {
            AppError::Config(msg) => assert!(msg.contains("Paddle"), "{msg}"),
            other => panic!("expected Config, got {other:?}"),
        }
        // Explicitly choosing Paddle is rejected too.
        assert!(validate(
            &req,
            &settings_with(Provider::Openai, Some(Provider::Paddleocr))
        )
        .is_err());
    }

    #[test]
    fn validate_rejects_missing_model() {
        let mut settings = settings_with(Provider::Openai, None);
        settings.openai_model = String::new();
        let req = req_with(vec![unit("page:1", "本埠新聞")]);
        assert!(validate(&req, &settings).is_err());
    }

    #[test]
    fn validate_honours_explicit_proofread_model_over_empty_provider_model() {
        // Empty provider model + explicit proofread model = valid.
        let mut settings = settings_with(Provider::OpenaiCompatible, None);
        settings.openai_compatible_base_url = "http://127.0.0.1:8000/v1".into();
        settings.openai_compatible_model = String::new();
        settings.proofread_model = "meta-llama/llama-3.1-8b".into();
        let req = req_with(vec![unit("page:1", "本埠新聞")]);
        assert!(validate(&req, &settings).is_ok());
    }

    #[test]
    fn validate_requires_a_base_url_for_openai_compatible() {
        // Left empty, every unit would discover the same misconfiguration
        // separately at send time — and would have burnt a job slot first.
        let mut settings = settings_with(Provider::OpenaiCompatible, None);
        settings.proofread_model = "local-model".into();
        let req = req_with(vec![unit("page:1", "本埠新聞")]);
        assert!(validate(&req, &settings).is_err());
    }

    fn req_with(units: Vec<ProofreadUnit>) -> ProofreadRequest {
        ProofreadRequest {
            file_id: "f1".into(),
            units,
            provider: None,
            model: None,
            prompt: None,
        }
    }

    #[test]
    fn validate_rejects_too_many_units() {
        let settings = settings_with(Provider::Openai, None);
        let units: Vec<_> = (0..=MAX_PROOFREAD_UNITS)
            .map(|i| unit(&format!("page:{i}"), "本埠新聞"))
            .collect();
        assert!(validate(&req_with(units), &settings).is_err());
    }

    #[test]
    fn validate_rejects_duplicate_keys() {
        let settings = settings_with(Provider::Openai, None);
        let req = req_with(vec![unit("page:1", "本埠新聞"), unit("page:1", "行政院令")]);
        assert!(validate(&req, &settings).is_err());
    }

    #[test]
    fn validate_counts_characters_not_bytes() {
        let settings = settings_with(Provider::Openai, None);
        // 20_000 Chinese characters is 60_000 bytes: a `len()`-based cap would
        // reject a page that is well inside the documented limit.
        let at_limit = "文".repeat(MAX_UNIT_CHARS);
        assert!(validate(&req_with(vec![unit("page:1", &at_limit)]), &settings).is_ok());
        let over = "文".repeat(MAX_UNIT_CHARS + 1);
        assert!(validate(&req_with(vec![unit("page:1", &over)]), &settings).is_err());
    }

    #[test]
    fn validate_rejects_an_oversized_prompt() {
        let mut settings = settings_with(Provider::Openai, None);
        settings.proofread_prompt = "字".repeat(MAX_PROMPT_CHARS + 1);
        let req = req_with(vec![unit("page:1", "本埠新聞")]);
        assert!(validate(&req, &settings).is_err());
    }

    #[test]
    fn validate_uses_the_request_snapshot_over_the_disk_value() {
        // The disk says "follow OCR" and OCR is Paddle — invalid. The
        // request's snapshot pins OpenRouter, and the job must validate (and
        // later run) against that merged view, not the disk.
        let settings = settings_with(Provider::Paddleocr, None);
        let mut req = req_with(vec![unit("page:1", "本埠新聞")]);
        req.provider = Some(Provider::Openrouter);
        req.model = Some("google/gemini-2.5-flash".into());
        assert!(validate(&req, &settings).is_ok());
    }

    #[test]
    fn validate_applies_the_prompt_limit_to_the_snapshot_prompt() {
        // The limits must bite on the merged view: a small disk prompt does
        // not excuse an oversized snapshot prompt, because the snapshot is
        // the one that actually runs.
        let settings = settings_with(Provider::Openai, None);
        let mut req = req_with(vec![unit("page:1", "本埠新聞")]);
        req.prompt = Some("字".repeat(MAX_PROMPT_CHARS + 1));
        assert!(validate(&req, &settings).is_err());
    }

    #[test]
    fn validate_rejects_the_prompt_multiplied_across_units() {
        // Small bodies, a prompt that is individually legal, and enough units
        // that the product blows the budget. Counting only the bodies (400
        // characters here) would wave this through as ~1/1000th of the limit.
        let mut settings = settings_with(Provider::Openai, None);
        settings.proofread_prompt = "字".repeat(MAX_PROMPT_CHARS);
        let units: Vec<_> = (0..100)
            .map(|i| unit(&format!("page:{i}"), "本埠新聞"))
            .collect();
        let err = validate(&req_with(units), &settings).unwrap_err();
        match err {
            AppError::Config(msg) => assert!(msg.contains("800400"), "{msg}"),
            other => panic!("expected Config, got {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_an_illegal_model_id() {
        let req = req_with(vec![unit("page:1", "本埠新聞")]);
        let mut long = settings_with(Provider::Openai, None);
        long.proofread_model = "m".repeat(MAX_MODEL_CHARS + 1);
        assert!(validate(&req, &long).is_err());
        let mut control = settings_with(Provider::Openai, None);
        control.proofread_model = "gpt-4o\nX-Injected: 1".into();
        assert!(validate(&req, &control).is_err());
    }

    #[test]
    fn validate_accepts_images_up_to_the_count_limit() {
        let settings = settings_with(Provider::Openai, None);
        // One image per unit, exactly at the limit.
        let units: Vec<_> = (0..MAX_IMAGES)
            .map(|i| unit_with_images(&format!("article:{i}"), vec![b64(1_000)]))
            .collect();
        assert!(validate(&req_with(units), &settings).is_ok());
    }

    #[test]
    fn validate_rejects_more_images_than_the_limit() {
        let settings = settings_with(Provider::Openai, None);
        let units: Vec<_> = (0..=MAX_IMAGES)
            .map(|i| unit_with_images(&format!("article:{i}"), vec![b64(1_000)]))
            .collect();
        assert!(validate(&req_with(units), &settings).is_err());
    }

    #[test]
    fn validate_counts_images_across_units_not_per_unit() {
        // A cross-page article carries one image per page it touches, so the
        // cap has to be a running total — checking `unit.images.len()` alone
        // would wave through 20 units of 20 images each.
        let settings = settings_with(Provider::Openai, None);
        let images: Vec<String> = (0..MAX_IMAGES + 1).map(|_| b64(1_000)).collect();
        let req = req_with(vec![unit_with_images("article:a", images)]);
        assert!(validate(&req, &settings).is_err());
    }

    #[test]
    fn validate_rejects_an_oversized_single_image() {
        let settings = settings_with(Provider::Openai, None);
        let req = req_with(vec![unit_with_images(
            "page:1",
            vec![b64(MAX_IMAGE_B64_BYTES + 4)],
        )]);
        assert!(validate(&req, &settings).is_err());
    }

    #[test]
    fn validate_rejects_an_oversized_image_total() {
        // Every image is individually legal; only the sum is not.
        let settings = settings_with(Provider::Openai, None);
        let per_image = MAX_IMAGES_TOTAL_B64_BYTES / MAX_IMAGES + 4;
        assert!(
            per_image <= MAX_IMAGE_B64_BYTES,
            "fixture would trip the per-image cap first"
        );
        let units: Vec<_> = (0..MAX_IMAGES)
            .map(|i| unit_with_images(&format!("article:{i}"), vec![b64(per_image)]))
            .collect();
        assert!(validate(&req_with(units), &settings).is_err());
    }

    #[test]
    fn validate_rejects_a_data_url_prefix_and_non_base64() {
        let settings = settings_with(Provider::Openai, None);
        // The mime type is the backend's to choose — a caller-supplied
        // `data:` prefix would let an untrusted request name any type.
        let prefixed = format!("data:image/jpeg;base64,{}", b64(100));
        let req = req_with(vec![unit_with_images("page:1", vec![prefixed])]);
        let err = validate(&req, &settings).unwrap_err();
        match err {
            AppError::Config(msg) => assert!(msg.contains("data:"), "{msg}"),
            other => panic!("expected Config, got {other:?}"),
        }

        let req = req_with(vec![unit_with_images("page:1", vec!["not base64!".into()])]);
        assert!(validate(&req, &settings).is_err());
        let req = req_with(vec![unit_with_images("page:1", vec![String::new()])]);
        assert!(validate(&req, &settings).is_err());
    }

    #[test]
    fn validate_still_accepts_a_unit_without_images() {
        // Capture can fail on the frontend; the unit then falls back to text
        // only, and refusing it would turn a missing bitmap into a failed
        // proofread.
        let settings = settings_with(Provider::Openai, None);
        assert!(validate(&req_with(vec![unit("page:1", "本埠新聞")]), &settings).is_ok());
    }

    #[test]
    fn validate_accepts_the_boundary_values() {
        let mut settings = settings_with(Provider::Openai, None);
        settings.proofread_prompt = "字".repeat(1_000);
        settings.proofread_model = "m".repeat(MAX_MODEL_CHARS);
        // 200 units × (1_000 body + 1_000 prompt) = exactly MAX_BUDGET_CHARS.
        let body = "文".repeat(1_000);
        let units: Vec<_> = (0..MAX_PROOFREAD_UNITS)
            .map(|i| unit(&format!("page:{i}"), &body))
            .collect();
        assert_eq!(
            units.len() * 2_000,
            MAX_BUDGET_CHARS,
            "fixture no longer sits on the boundary"
        );
        assert!(validate(&req_with(units.clone()), &settings).is_ok());

        // One character past it is refused.
        let mut over = units;
        over[0].text.push('文');
        assert!(validate(&req_with(over), &settings).is_err());
    }
}
