//! LLM proofread pass: suggestion types, response parsing, and anchor
//! validation.
//!
//! The model is asked for *structured correction suggestions*, never a
//! rewritten full text. A suggestion is only kept if its `before` fragment
//! (prefixed by `context_before`) can be located **uniquely** in the source
//! text — this module is where hallucinated or ambiguous edits die, before
//! any UI shows them.
//!
//! Whitespace is normalized on both sides first: Paddle's vertical-script
//! output breaks lines very finely, and an LLM would otherwise drown the
//! diff in meaningless whitespace churn.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::i18n::Language;

/// Hard cap for the proofread chat call. Sized for a full newspaper page of
/// suggestions: each suggestion carries `before` + `after` + context +
/// reason, and a dense page can easily produce 50–100 of them — far beyond
/// the OCR path's 4096, which would silently cut the JSON array in half.
pub const PROOFREAD_MAX_TOKENS: u32 = 16384;

/// Appended to the resolved proofread prompt whenever the unit carries page
/// images. The user's own prompt is left intact and keeps its authority over
/// *what* to correct; this only tells the model what the extra attachment is
/// and how far it may go with it.
///
/// The placeholder clause is the point of the whole image pass: a text-only
/// proofread cannot do anything with a `[待核]` marker — it has no way to know
/// what the original said — so it correctly stays silent. With the scan
/// attached, resolving those markers becomes the single highest-value edit the
/// model can make, and it is spelled out explicitly because the user's prompt
/// (which predates images) says nothing about attachments.
/// The language is a parameter rather than a read of the process-wide value
/// so this stays testable in both wordings without mutating a global the rest
/// of the parallel test suite is reading — the same contract
/// [`crate::config::default_proofread_prompt`] follows.
pub fn image_prompt_appendix(language: Language) -> &'static str {
    crate::i18n::pick(
        "\n\n附图为该文本对应的原件扫描。请对照图像核对文本：以图像为准判断文字是否误识。对 [待核]、□ 等占位标记，若图像中能确认原文，以 garble 类别给出替换建议；图像不清或依据不足时不要提出。图像仅用于核对，不要转录图中未出现在文本里的其他内容。",
        "\n\nThe attached image is the scan of the original this text was transcribed from. Check the text against it: the image decides whether a character was mis-recognized. For placeholder markers such as [待核] or □, propose a replacement under the `garble` category when the image settles what the original said; propose nothing when the image is unclear or the evidence is thin. The image is for verification only — do not transcribe other content from it that is absent from the text.",
        matches!(language, Language::En),
    )
}

/// The system prompt one unit actually runs with. Text-only units are left
/// exactly as the user wrote them; image-bearing units get the appendix
/// appended at the end, where it cannot be truncated away by a long user
/// prompt (which is capped separately in `jobs::proofread::validate`).
pub fn prompt_for_unit(prompt: &str, has_images: bool, language: Language) -> String {
    if has_images {
        format!("{prompt}{}", image_prompt_appendix(language))
    } else {
        prompt.to_string()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProofreadCategory {
    /// Punctuation / paragraph segmentation.
    Punct,
    /// Similar-character or variant-character confusion.
    Charform,
    /// Mojibake / dropped characters.
    Garble,
    /// Column-order / line-break mistakes.
    Layout,
    /// Semantic rewrites. Defaults to *rejected* in the UI: a historical
    /// transcript must keep its original wording.
    Semantic,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProofreadSuggestion {
    /// The mis-recognized fragment, which must appear verbatim in the source
    /// text (modulo whitespace normalization).
    pub before: String,
    /// The corrected fragment. Empty = a pure deletion.
    pub after: String,
    /// Source text immediately preceding `before`, for unique anchoring.
    /// May be empty; suggestions without context survive only when `before`
    /// alone is unique in the whole text.
    #[serde(default)]
    pub context_before: String,
    pub category: ProofreadCategory,
    pub confidence: f64,
    #[serde(default)]
    pub reason: String,
}

/// Folds whitespace for anchoring: every whitespace character is *deleted*,
/// not collapsed to a space. In vertical-script Chinese text any whitespace
/// between characters is a layout artifact (Paddle breaks lines finely, and
/// the model quotes fragments with or without those breaks), so deleting it
/// on both sides makes the model's rendering of a line break irrelevant.
/// Anchoring is read-only — the original text is never modified.
pub fn normalize_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if !ch.is_whitespace() {
            out.push(ch);
        }
    }
    out
}

/// Counts occurrences of `needle` in `haystack`, advancing one *character*
/// at a time so that overlapping candidates are all counted: `哈哈哈`
/// contains `哈哈` at offsets 0 and 1. A self-overlapping anchor must read
/// as ambiguous — "the first occurrence" is not a defined position, and a
/// correction aimed at the second candidate would silently land on the
/// first one. (`str::match_indices` only reports non-overlapping matches,
/// which would let that example through as "unique".)
///
/// The full count is kept (rather than bailing out at 2) so the Rust and
/// TypeScript sides can assert exact numbers against the same contract
/// table; the caller only ever compares with `1`, and a page of text is
/// short enough that the extra counting is free.
fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut count = 0usize;
    let mut start = 0usize;
    while let Some(off) = haystack[start..].find(needle) {
        count += 1;
        let abs = start + off;
        // Advance by one character, not one needle-length — that advance is
        // the whole point: overlapping candidates are distinct positions.
        start = abs + haystack[abs..].chars().next().map_or(1, |c| c.len_utf8());
    }
    count
}

/// Validates each suggestion against the source text and returns the
/// survivors plus the number of dropped ones.
///
/// Rules, per the plan: the concatenation of `context_before` + `before`
/// (normalized, as one string — the boundary between them may carry
/// whitespace in the model's rendering but none in the source) must occur
/// **exactly once** in the normalized source. Zero occurrences = the model
/// hallucinated a fragment; more than one = the anchor is ambiguous. Both
/// are dropped outright — no fuzzy matching, by design: a correction applied
/// at the wrong position is worse than a missed correction.
pub fn anchor_suggestions(
    text: &str,
    suggestions: Vec<ProofreadSuggestion>,
) -> (Vec<ProofreadSuggestion>, u32) {
    let norm_text = normalize_whitespace(text);
    let mut kept = Vec::with_capacity(suggestions.len());
    let mut discarded = 0u32;

    for suggestion in suggestions {
        if suggestion.before.trim().is_empty() {
            discarded += 1;
            continue;
        }
        // Concatenate first, normalize once: if the model put a line break
        // between context and before (or none), the normalized join matches
        // the normalized source either way.
        let raw = format!("{}{}", suggestion.context_before, suggestion.before);
        let needle = normalize_whitespace(&raw);
        if count_occurrences(&norm_text, &needle) == 1 {
            kept.push(suggestion);
        } else {
            discarded += 1;
        }
    }

    (kept, discarded)
}

/// Extracts a JSON array out of a model response. Models wrap arrays in
/// Markdown fences, prefix them with prose, or trail them with commentary;
/// this takes the first `[` … last `]` span, with a dedicated path for
/// `` ```json … ``` `` fences.
pub fn extract_json_array(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if trimmed.starts_with("```") {
        let after_open = trimmed.strip_prefix("```").unwrap_or(trimmed);
        let after_lang = after_open.strip_prefix("json").unwrap_or(after_open);
        let body = after_lang.trim_start_matches(['\r', '\n']);
        if let Some(end) = body.find("```") {
            return extract_json_array(&body[..end]);
        }
    }
    let start = trimmed.find('[')?;
    let end = trimmed.rfind(']')?;
    if end < start {
        return None;
    }
    // Both delimiters are single-byte ASCII, so slicing at their byte
    // indices is always on char boundaries.
    Some(&trimmed[start..=end])
}

/// Parses a model response into suggestions. Parse failures are reported
/// loudly rather than dropped: a half-array is exactly what a `max_tokens`
/// truncation produces, and the user must see *that* instead of a quietly
/// short suggestion list (the `finish_reason` check in `openai.rs` catches
/// most truncations before this point; this is the second net).
///
/// A response with no array at all is a different failure: the model
/// answered in prose (a refusal, a clarification, a chatty "no changes
/// needed"). Echo the start of what it said — without it the user sees only
/// "no JSON array" and has no way to tell a refusal from a broken endpoint.
pub fn parse_suggestions(raw: &str) -> AppResult<Vec<ProofreadSuggestion>> {
    let json = extract_json_array(raw).ok_or_else(|| {
        let trimmed = raw.trim();
        let snippet: String = trimmed.chars().take(120).collect();
        let message = if trimmed.is_empty() {
            crate::tr!(
                "模型返回了空响应。",
                "The model returned an empty response."
            )
            .to_string()
        } else if trimmed.contains('[') {
            // An opened-but-never-closed array is what a mid-stream cutoff
            // looks like; the finish_reason net upstream catches most of
            // these, but not a provider that truncates without saying so.
            crate::tr!(
                "模型响应中的 JSON 数组不完整（响应可能被截断）。",
                "The JSON array in the model response is incomplete (it may have been truncated)."
            )
            .to_string()
        } else {
            crate::trf!(
                "模型没有按要求输出 JSON 数组，而是回复：{}",
                "The model did not return a JSON array; it replied: {}",
                snippet
            )
        };
        AppError::Ocr {
            provider: "proofread".into(),
            message,
            retryable: false,
        }
    })?;
    serde_json::from_str(json).map_err(|e| AppError::Ocr {
        provider: "proofread".into(),
        message: crate::trf!(
            "校对建议 JSON 解析失败（响应可能被截断）：{}",
            "Could not parse the suggestion JSON (the response may be truncated): {}",
            e
        ),
        retryable: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn suggestion(
        before: &str,
        after: &str,
        context_before: &str,
        category: ProofreadCategory,
    ) -> ProofreadSuggestion {
        ProofreadSuggestion {
            before: before.into(),
            after: after.into(),
            context_before: context_before.into(),
            category,
            confidence: 0.9,
            reason: "test".into(),
        }
    }

    #[test]
    fn prompt_for_unit_appends_the_appendix_only_when_images_ride_along() {
        let user_prompt = "只修 OCR 误识";
        // Text-only units must run on exactly the prompt the user wrote.
        assert_eq!(
            prompt_for_unit(user_prompt, false, Language::Zh),
            user_prompt
        );

        for language in [Language::Zh, Language::En] {
            let with_images = prompt_for_unit(user_prompt, true, language);
            assert!(
                with_images.starts_with(user_prompt),
                "the user's prompt must keep its authority and come first"
            );
            assert!(with_images.ends_with(image_prompt_appendix(language)));
        }
    }

    #[test]
    fn image_prompt_appendix_is_language_specific_and_names_the_placeholder_case() {
        // The `[待核]` clause is the reason the image pass exists — a text-only
        // proofread has no way to resolve those markers.
        let zh = image_prompt_appendix(Language::Zh);
        assert!(zh.contains("待核") && zh.contains("garble"), "{zh}");
        let en = image_prompt_appendix(Language::En);
        assert!(en.contains("待核") && en.contains("garble"), "{en}");
        assert_ne!(zh, en);
    }

    #[test]
    fn normalize_deletes_all_whitespace() {
        assert_eq!(normalize_whitespace("a\n\nb\tc"), "abc");
        // NBSP and full-width space are whitespace too.
        assert_eq!(normalize_whitespace("a\u{00a0}b\u{3000}c"), "abc");
        assert_eq!(normalize_whitespace("  padded  "), "padded");
        assert_eq!(normalize_whitespace(""), "");
    }

    #[test]
    fn anchor_keeps_a_uniquely_located_suggestion() {
        let text = "本埠新聞，巳於昨日到達。";
        let (kept, discarded) = anchor_suggestions(
            text,
            vec![suggestion(
                "巳",
                "已",
                "本埠新聞，",
                ProofreadCategory::Charform,
            )],
        );
        assert_eq!(discarded, 0);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].after, "已");
    }

    #[test]
    fn anchor_survives_line_breaks_in_the_source() {
        // Paddle's vertical output breaks lines finely; the model may quote
        // the fragment with or without the break. Normalization makes both
        // land.
        let text = "本埠新聞，\n巳於昨日到達。";
        let (kept, _) = anchor_suggestions(
            text,
            vec![suggestion(
                "巳",
                "已",
                "本埠新聞，",
                ProofreadCategory::Charform,
            )],
        );
        assert_eq!(kept.len(), 1);
    }

    #[test]
    fn anchor_drops_hallucinated_fragments() {
        let text = "本埠新聞，巳於昨日到達。";
        let (kept, discarded) = anchor_suggestions(
            text,
            vec![suggestion(
                "巳於今年",
                "已於今年",
                "本埠新聞，",
                ProofreadCategory::Charform,
            )],
        );
        assert_eq!(kept.len(), 0);
        assert_eq!(discarded, 1);
    }

    #[test]
    fn anchor_drops_ambiguous_fragments() {
        let text = "一月已過，二月已過。";
        let (kept, discarded) = anchor_suggestions(
            text,
            vec![suggestion("已過", "巳過", "", ProofreadCategory::Charform)],
        );
        assert_eq!(kept.len(), 0);
        assert_eq!(discarded, 1);
    }

    #[test]
    fn anchor_drops_empty_before() {
        let text = "原文。";
        let (kept, discarded) = anchor_suggestions(
            text,
            vec![suggestion("", "漏字", "原文", ProofreadCategory::Garble)],
        );
        assert_eq!(kept.len(), 0);
        assert_eq!(discarded, 1);
    }

    #[test]
    fn anchor_keeps_deletion_with_empty_after() {
        let text = "於是乎到達。";
        let (kept, discarded) = anchor_suggestions(
            text,
            vec![suggestion("乎", "", "於是", ProofreadCategory::Garble)],
        );
        assert_eq!(discarded, 0);
        assert_eq!(kept.len(), 1);
        assert!(kept[0].after.is_empty());
    }

    #[test]
    fn overlapping_occurrences_are_all_counted() {
        // Contract table shared with the TypeScript tests — the two sides
        // must agree on when an anchor is unique.
        assert_eq!(count_occurrences("哈哈哈", "哈哈"), 2);
        assert_eq!(count_occurrences("一一一一", "一一"), 3);
        assert_eq!(count_occurrences("甲乙丙丁", "乙丙"), 1);
    }

    #[test]
    fn overlapping_anchor_is_treated_as_ambiguous() {
        // `哈哈` occurs at offsets 0 and 1; non-overlap counting would call
        // that unique and apply the correction to the first candidate, which
        // may be exactly the wrong one.
        let (kept, discarded) = anchor_suggestions(
            "哈哈哈",
            vec![suggestion("哈哈", "呵呵", "", ProofreadCategory::Charform)],
        );
        assert_eq!(kept.len(), 0);
        assert_eq!(discarded, 1);
    }

    #[test]
    fn anchor_requires_unique_occurrence_even_with_context() {
        // context_before + before appears twice → ambiguous → dropped.
        let text = "甲巳於昨日到達，乙巳於昨日出發。";
        let (kept, discarded) = anchor_suggestions(
            text,
            vec![suggestion(
                "巳於昨日",
                "已於昨日",
                "",
                ProofreadCategory::Charform,
            )],
        );
        assert_eq!(kept.len(), 0);
        assert_eq!(discarded, 1);
    }

    #[test]
    fn extract_handles_bare_array() {
        assert_eq!(extract_json_array("[1, 2]"), Some("[1, 2]"));
    }

    #[test]
    fn extract_handles_fenced_array() {
        assert_eq!(
            extract_json_array("```json\n[{\"a\": 1}]\n```"),
            Some("[{\"a\": 1}]")
        );
        assert_eq!(extract_json_array("```\n[1]\n```"), Some("[1]"));
    }

    #[test]
    fn extract_handles_surrounding_prose() {
        assert_eq!(
            extract_json_array("Here are the results:\n[1, 2]\nHope this helps."),
            Some("[1, 2]")
        );
    }

    #[test]
    fn extract_returns_none_without_an_array() {
        assert_eq!(extract_json_array("no array here"), None);
        assert_eq!(extract_json_array(""), None);
    }

    #[test]
    fn parse_suggestions_round_trips() {
        let raw = r#"```json
        [
          {
            "before": "巳",
            "after": "已",
            "context_before": "本埠新聞，",
            "category": "charform",
            "confidence": 0.9,
            "reason": "形近字误识"
          }
        ]
        ```"#;
        let parsed = parse_suggestions(raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].category, ProofreadCategory::Charform);
    }

    #[test]
    fn parse_reports_unparseable_json_loudly() {
        let err = parse_suggestions("```json\n[{ \"before\": \n```").unwrap_err();
        match err {
            AppError::Ocr { message, .. } => {
                assert!(
                    message.contains("截断") || message.contains("truncated"),
                    "{message}"
                );
            }
            other => panic!("expected Ocr, got {other:?}"),
        }
    }

    #[test]
    fn parse_echoes_a_prose_reply() {
        // A refusal / clarification must surface verbatim — "no JSON array"
        // alone gives the user nothing to act on.
        let err = parse_suggestions("抱歉，我需要更多上下文才能校对这段文本。").unwrap_err();
        match err {
            AppError::Ocr { message, .. } => {
                assert!(message.contains("抱歉，我需要更多上下文"), "{message}");
            }
            other => panic!("expected Ocr, got {other:?}"),
        }
    }

    #[test]
    fn parse_reports_an_empty_reply() {
        let err = parse_suggestions("   ").unwrap_err();
        match err {
            AppError::Ocr { message, .. } => {
                assert!(
                    message.contains("空响应") || message.contains("empty response"),
                    "{message}"
                );
            }
            other => panic!("expected Ocr, got {other:?}"),
        }
    }
}
