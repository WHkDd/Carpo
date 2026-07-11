use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const STORE_FILE: &str = "settings.json";

/// Default OCR prompt — mirrors `_OCR_PROMPT` in `newspaper_ocr.py:296`.
const DEFAULT_OCR_PROMPT: &str = "请识别并转录图中所有文字。这是一份近代中文报纸的版块图像，文字方向可能为竖排（从上到下，从右到左）或横排。请按原文顺序输出所有文字，不要添加任何解释、标注或格式。";

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
    pub ocr_prompt: String,
    pub paddle_url: String,
    pub paddle_model: String,
    #[serde(default)]
    pub paddle_document_options: PaddleDocumentOptions,
    pub openai_model: String,
    pub openrouter_model: String,
    pub openai_compatible_base_url: String,
    pub openai_compatible_model: String,
}

impl Default for NonSecretSettings {
    fn default() -> Self {
        Self {
            provider: Provider::Openai,
            ocr_profile: OcrProfile::Standard,
            ocr_prompt: DEFAULT_OCR_PROMPT.to_string(),
            paddle_url: "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs".to_string(),
            paddle_model: "PaddleOCR-VL-1.6".to_string(),
            paddle_document_options: PaddleDocumentOptions::default(),
            openai_model: "gpt-4o".to_string(),
            openrouter_model: "google/gemini-2.5-flash-preview".to_string(),
            openai_compatible_base_url: String::new(),
            openai_compatible_model: String::new(),
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
    serde_json::from_str::<NonSecretSettings>(&raw)
        .map_err(|e| AppError::Config(format!("settings parse {}: {e}", path.display())))
}

pub fn save(data_dir: &Path, s: &NonSecretSettings) -> AppResult<()> {
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

        assert!(parsed.paddle_document_options.use_layout_detection);
        assert!(!parsed.paddle_document_options.include_header_image);
        assert_eq!(parsed.paddle_document_options.prompt_label, "ocr");
    }
}
