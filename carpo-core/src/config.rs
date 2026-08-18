use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::i18n::{self, Language};

const STORE_FILE: &str = "settings.json";

/// Language for a settings file that predates localization: it was written
/// by a Chinese-only build, so that is what its owner has been reading.
fn legacy_language() -> Option<Language> {
    Some(Language::Zh)
}

/// Default OCR prompt. The Chinese wording mirrors `_OCR_PROMPT` in
/// `newspaper_ocr.py:296`; the English one is its translation and is what a
/// fresh English install starts with. Kept in step with
/// `settings.defaultPrompt` in `src/i18n/messages.ts`, which the settings
/// dialog shows as the placeholder and restores on "Restore default".
pub fn default_ocr_prompt(language: Language) -> String {
    match language {
        Language::Zh => "请识别并转录图中所有文字。这是一份近代中文报纸的版块图像，文字方向可能为竖排（从上到下，从右到左）或横排。请按原文顺序输出所有文字，不要添加任何解释、标注或格式。".to_string(),
        Language::En => "Transcribe every piece of text in the image. It is a block cropped from a historical Chinese newspaper; the text may run vertically (top to bottom, right to left) or horizontally. Output all of the text in its original order, with no explanations, annotations or formatting.".to_string(),
    }
}

/// Default proofread prompt. This is the system prompt for the LLM pass that
/// turns raw OCR output into structured correction suggestions; the source
/// text itself is sent as the user message. The wording deliberately hammers
/// on one point: this is a transcription of a historical artifact, so the
/// model may fix recognition errors but never "improve" the original
/// orthography — variant characters, old glyph forms and vertical-typeset
/// punctuation habits are all features, not bugs.
pub fn default_proofread_prompt(language: Language) -> String {
    match language {
        Language::Zh => "你正在校对一份近代中文报纸页面的 OCR 转录文本。这是历史原件转录，请只修正 OCR 误识（形近字、乱码、缺字、错行），不得改动原文用字习惯：异体字、旧字形、繁体写法、竖排标点样式一律保留；不得润色或改写行文。\n\n对每一处建议的修订输出一个 JSON 对象，字段如下：\n- \"before\": 原文中被误识的片段（必须逐字出现在原文中）\n- \"after\": 修正后的片段（删字建议可为空字符串）\n- \"context_before\": \"before\" 之前的原文片段，5–20 字，用于唯一定位（不要包含 \"before\" 本身）\n- \"category\": 类别，只能是 punct（标点分段）、charform（形近字异体字）、garble（乱码缺字）、layout（栏序换行）、semantic（语义改写）之一\n- \"confidence\": 0 到 1 之间的置信度\n- \"reason\": 一句话说明修订理由\n\n没有把握的修订不要提出。只输出一个 JSON 数组（可以为空），不要输出任何其他文字、注释或代码块标记。".to_string(),
        Language::En => "You are proofreading the OCR transcript of a page from a historical Chinese newspaper. This is a transcription of the original artifact: fix only OCR errors (similar-character confusion, mojibake, dropped characters, mis-ordered lines) and never touch the original orthography — variant characters, old glyph forms, traditional forms and vertical-typeset punctuation habits are features, not bugs. Do not polish or rewrite the wording.\n\nFor each suggested correction, output one JSON object with these fields:\n- \"before\": the mis-recognized fragment, which must appear verbatim in the source text\n- \"after\": the corrected fragment (an empty string for a deletion)\n- \"context_before\": the source text immediately preceding \"before\", 5–20 characters, for unique anchoring (do not include \"before\" itself)\n- \"category\": one of punct, charform, garble, layout, semantic\n- \"confidence\": a number between 0 and 1\n- \"reason\": a one-sentence justification\n\nDo not propose corrections you are not confident about. Output a single JSON array only (possibly empty), with no other text, commentary, or code fences.".to_string(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Paddleocr,
    Openai,
    Openrouter,
    OpenaiCompatible,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OcrProfile {
    Standard,
    Fast,
}

impl OcrProfile {
    pub fn ocr_dpi(self) -> u32 {
        match self {
            OcrProfile::Standard => 300,
            OcrProfile::Fast => 200,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaddleDocumentOptions {
    pub include_header: bool,
    pub include_footer: bool,
    pub include_page_number: bool,
    pub include_aside_text: bool,
    pub include_header_image: bool,
    pub include_footer_image: bool,
    pub include_footnote: bool,
    pub use_doc_orientation_classify: bool,
    pub use_doc_unwarping: bool,
    pub use_layout_detection: bool,
    pub use_chart_recognition: bool,
    pub use_seal_recognition: bool,
    pub use_ocr_for_image_block: bool,
    pub merge_tables: bool,
    pub relevel_titles: bool,
    pub layout_shape_mode: String,
    pub prompt_label: String,
    pub repetition_penalty: f64,
    pub temperature: f64,
    pub top_p: f64,
    pub min_pixels: u32,
    pub max_pixels: u32,
    pub layout_nms: bool,
    pub restructure_pages: bool,
}

impl Default for PaddleDocumentOptions {
    fn default() -> Self {
        Self {
            include_header: true,
            include_footer: true,
            include_page_number: true,
            include_aside_text: true,
            include_header_image: false,
            include_footer_image: false,
            include_footnote: true,
            use_doc_orientation_classify: false,
            use_doc_unwarping: false,
            use_layout_detection: true,
            use_chart_recognition: false,
            use_seal_recognition: true,
            use_ocr_for_image_block: false,
            merge_tables: true,
            relevel_titles: true,
            layout_shape_mode: "auto".to_string(),
            prompt_label: "ocr".to_string(),
            repetition_penalty: 1.0,
            temperature: 0.0,
            top_p: 1.0,
            min_pixels: 147_384,
            max_pixels: 2_822_400,
            layout_nms: true,
            restructure_pages: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NonSecretSettings {
    pub provider: Provider,
    pub ocr_profile: OcrProfile,
    /// UI language, mirrored here so backend progress labels and error
    /// messages come back in the language the user is reading.
    ///
    /// `None` means "never chosen", which the frontend answers by adopting
    /// the system locale and saving the result. Settings files written
    /// before localization existed deserialize to `Some(Zh)` instead
    /// (see [`legacy_language`]) so an existing install keeps the Chinese
    /// wording it already had.
    #[serde(default = "legacy_language")]
    pub language: Option<Language>,
    pub ocr_prompt: String,
    pub paddle_url: String,
    pub paddle_model: String,
    #[serde(default)]
    pub paddle_document_options: PaddleDocumentOptions,
    pub openai_model: String,
    pub openrouter_model: String,
    pub openai_compatible_base_url: String,
    pub openai_compatible_model: String,
    /// Which provider runs the LLM proofread pass. `None` = follow
    /// [`NonSecretSettings::provider`] (the OCR provider). A provider may be
    /// used for both OCR and proofreading with different models — OCR via
    /// OpenAI with proofreading via Claude is covered by pointing this at
    /// `openrouter` and setting `proofread_model`.
    #[serde(default)]
    pub proofread_provider: Option<Provider>,
    /// Model for the proofread pass. Empty = fall back to the resolved
    /// provider's OCR model field.
    #[serde(default)]
    pub proofread_model: String,
    #[serde(default)]
    pub proofread_prompt: String,
}

impl Default for NonSecretSettings {
    fn default() -> Self {
        Self {
            provider: Provider::Openai,
            ocr_profile: OcrProfile::Standard,
            // Fresh install: let the frontend pick from the system locale.
            language: None,
            ocr_prompt: default_ocr_prompt(i18n::language()),
            paddle_url: "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs".to_string(),
            paddle_model: "PaddleOCR-VL-1.6".to_string(),
            paddle_document_options: PaddleDocumentOptions::default(),
            openai_model: "gpt-4o".to_string(),
            openrouter_model: "google/gemini-2.5-flash-preview".to_string(),
            openai_compatible_base_url: String::new(),
            openai_compatible_model: String::new(),
            proofread_provider: None,
            proofread_model: String::new(),
            proofread_prompt: default_proofread_prompt(i18n::language()),
        }
    }
}

pub fn load(data_dir: &Path) -> AppResult<NonSecretSettings> {
    let path = data_dir.join(STORE_FILE);
    if !path.exists() {
        return Ok(NonSecretSettings::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| AppError::Config(format!("settings read {}: {e}", path.display())))?;
    let settings = serde_json::from_str::<NonSecretSettings>(&raw)
        .map_err(|e| AppError::Config(format!("settings parse {}: {e}", path.display())))?;
    i18n::set_language(settings.language.unwrap_or_default());
    Ok(settings)
}

pub fn save(data_dir: &Path, s: &NonSecretSettings) -> AppResult<()> {
    i18n::set_language(s.language.unwrap_or_default());
    fs::create_dir_all(data_dir)
        .map_err(|e| AppError::Config(format!("settings dir {}: {e}", data_dir.display())))?;
    let path = data_dir.join(STORE_FILE);
    let raw = serde_json::to_vec_pretty(s)
        .map_err(|e| AppError::Config(format!("settings encode: {e}")))?;
    fs::write(&path, raw)
        .map_err(|e| AppError::Config(format!("settings save {}: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ocr_profile_dpi_mapping_matches_frontend_constants() {
        // Mirror of `src/lib/ocr-profile.ts::PROFILE_DPI[*].ocr`. If either
        // side moves, this test is the canary so the two stop drifting.
        assert_eq!(OcrProfile::Standard.ocr_dpi(), 300);
        assert_eq!(OcrProfile::Fast.ocr_dpi(), 200);
    }

    #[test]
    fn settings_without_paddle_document_options_gets_defaults() {
        let parsed: NonSecretSettings = serde_json::from_value(json!({
            "provider": "paddleocr",
            "ocr_profile": "standard",
            "ocr_prompt": "",
            "paddle_url": "",
            "paddle_model": "PaddleOCR-VL-1.6",
            "openai_model": "",
            "openrouter_model": "",
            "openai_compatible_base_url": "",
            "openai_compatible_model": ""
        }))
        .unwrap();

        // Pre-localization settings files keep the Chinese wording they were
        // written with, rather than falling back to the locale.
        assert_eq!(parsed.language, Some(Language::Zh));
        assert_eq!(NonSecretSettings::default().language, None);

        assert!(parsed.paddle_document_options.use_layout_detection);
        assert!(!parsed.paddle_document_options.include_header_image);
        assert_eq!(parsed.paddle_document_options.prompt_label, "ocr");
    }

    #[test]
    fn settings_without_proofread_fields_gets_defaults() {
        // The three proofread fields must be additive: a settings file
        // written before the proofread rollout still parses. The prompt
        // deserializes to "" — `ocr::resolve_proofread_prompt` falls back
        // to the built-in default at call time, which is when the process
        // language is known.
        let parsed: NonSecretSettings = serde_json::from_value(json!({
            "provider": "openai",
            "ocr_profile": "standard",
            "ocr_prompt": "",
            "paddle_url": "",
            "paddle_model": "",
            "openai_model": "gpt-4o",
            "openrouter_model": "",
            "openai_compatible_base_url": "",
            "openai_compatible_model": ""
        }))
        .unwrap();

        assert_eq!(parsed.proofread_provider, None);
        assert_eq!(parsed.proofread_model, "");
        assert_eq!(parsed.proofread_prompt, "");
    }

    #[test]
    fn default_proofread_prompt_is_language_specific() {
        assert!(default_proofread_prompt(Language::Zh).contains("历史原件转录"));
        assert!(default_proofread_prompt(Language::En).contains("historical Chinese newspaper"));
    }
}
