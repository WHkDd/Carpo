//! Backend message localization.
//!
//! Progress labels and `AppError` messages produced here are shown verbatim
//! in the UI, so they have to follow the language the user picked in the
//! settings dialog. The choice rides along in [`crate::config::NonSecretSettings`];
//! `config::load` / `config::save` and every job entry point push it into the
//! process-wide value below, and the [`tr!`] / [`trf!`] macros read it.
//!
//! A single global (rather than threading a `Language` through every call) is
//! deliberate: one desktop app — or one server — serves one user at a time,
//! and the alternative would touch every signature in the OCR pipeline.

use std::sync::atomic::{AtomicU8, Ordering};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    #[default]
    Zh,
    En,
}

const ZH: u8 = 0;
const EN: u8 = 1;

static LANGUAGE: AtomicU8 = AtomicU8::new(ZH);

pub fn set_language(language: Language) {
    LANGUAGE.store(
        match language {
            Language::Zh => ZH,
            Language::En => EN,
        },
        Ordering::Relaxed,
    );
}

pub fn language() -> Language {
    match LANGUAGE.load(Ordering::Relaxed) {
        EN => Language::En,
        _ => Language::Zh,
    }
}

pub fn is_english() -> bool {
    LANGUAGE.load(Ordering::Relaxed) == EN
}

/// Chooses between two wordings. Split out of [`tr!`] so it can be tested
/// without mutating the global (the test suite runs in parallel and other
/// tests assert on localized messages).
pub fn pick<'a>(zh: &'a str, en: &'a str, english: bool) -> &'a str {
    if english {
        en
    } else {
        zh
    }
}

/// Picks the wording for a fixed message: `tr!("中文", "English")`.
#[macro_export]
macro_rules! tr {
    ($zh:literal, $en:literal $(,)?) => {
        $crate::i18n::pick($zh, $en, $crate::i18n::is_english())
    };
}

/// Same as [`tr!`] for messages with `format!` arguments. Both templates take
/// the same positional arguments, so they stay in step by construction.
#[macro_export]
macro_rules! trf {
    ($zh:literal, $en:literal $(, $arg:expr)* $(,)?) => {
        if $crate::i18n::is_english() {
            format!($en $(, $arg)*)
        } else {
            format!($zh $(, $arg)*)
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_follows_the_requested_language() {
        assert_eq!(pick("中文", "English", false), "中文");
        assert_eq!(pick("中文", "English", true), "English");
    }

    #[test]
    fn default_language_is_chinese() {
        // Other tests in this crate assert on Chinese messages, so nothing
        // here may flip the global — only read it.
        assert_eq!(language(), Language::Zh);
        assert!(!is_english());
    }

    #[test]
    fn language_round_trips_through_serde() {
        assert_eq!(serde_json::to_string(&Language::En).unwrap(), "\"en\"");
        assert_eq!(
            serde_json::from_str::<Language>("\"zh\"").unwrap(),
            Language::Zh
        );
        assert_eq!(Language::default(), Language::Zh);
    }
}
