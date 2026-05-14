use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use crate::error::{AppError, AppResult};

const STORE_FILE: &str = "settings.json";
const STORE_KEY: &str = "settings";

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
    /// Render DPI used when handing pages to OCR providers. Owned by the
    /// backend so the request DTO's `ocr_dpi` field can no longer drift
    /// from the persisted profile (it used to be computed by the frontend
    /// and tunneled through every request).
    pub fn ocr_dpi(self) -> u32 {
        match self {
            OcrProfile::Standard => 300,
            OcrProfile::Fast => 200,
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
            paddle_model: "PaddleOCR-VL-1.5".to_string(),
            openai_model: "gpt-4o".to_string(),
            openrouter_model: "google/gemini-2.5-flash-preview".to_string(),
            openai_compatible_base_url: String::new(),
            openai_compatible_model: String::new(),
        }
    }
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> AppResult<NonSecretSettings> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::Config(format!("store open: {e}")))?;
    let Some(raw) = store.get(STORE_KEY) else {
        return Ok(NonSecretSettings::default());
    };
    serde_json::from_value::<NonSecretSettings>(raw)
        .map_err(|e| AppError::Config(format!("settings parse: {e}")))
}

pub fn save<R: Runtime>(app: &AppHandle<R>, s: &NonSecretSettings) -> AppResult<()> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::Config(format!("store open: {e}")))?;
    let value =
        serde_json::to_value(s).map_err(|e| AppError::Config(format!("settings encode: {e}")))?;
    store.set(STORE_KEY, value);
    store
        .save()
        .map_err(|e| AppError::Config(format!("store save: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ocr_profile_dpi_mapping_matches_frontend_constants() {
        // Mirror of `src/lib/ocr-profile.ts::PROFILE_DPI[*].ocr`. If either
        // side moves, this test is the canary so the two stop drifting.
        assert_eq!(OcrProfile::Standard.ocr_dpi(), 300);
        assert_eq!(OcrProfile::Fast.ocr_dpi(), 200);
    }
}
