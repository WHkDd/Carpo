//! Import + preflight for Paddle web-export JSON files.
//!
//! The Paddle OCR web demo lets users run full-document OCR and download the
//! result as JSON. This module reads that JSON, produces a structural
//! preflight report (page count, block-label histogram, missing-field
//! warnings), and converts the per-page parsing results into the project's
//! own [`LayoutDocument`] intermediate model. The right-side text panel
//! consumes the per-page texts; the layout-rebuilt PDF exporter (Phase 7)
//! will consume the [`LayoutDocument`].
//!
//! ## Accepted JSON shapes
//!
//! The web demo and the v2 jobs endpoint expose slightly different envelopes:
//! - Top-level array, one item per page (the typical web-demo download).
//! - `{ "result": { "layoutParsingResults": [...] } }` (the v2 jobs JSONL,
//!   merged into a single object per page).
//! - `{ "layoutParsingResults": [...] }` (a thin variant some pipelines emit).
//! - `{ "pages": [...] }` or `{ "results": [...] }` as community
//!   pre-processing scripts have been observed to produce.
//!
//! We tolerate the variants instead of failing fast: the parser walks
//! `serde_json::Value` directly, so missing fields surface as preflight
//! warnings rather than parse errors. Anything truly unparseable (binary
//! file, syntax error, top-level neither array nor object) returns an
//! [`AppError::Internal`] from the caller.
//!
//! ## Per-page parsing
//!
//! Inside a page item we look for:
//! - `prunedResult.parsing_res_list` (preferred), falling back to
//!   `parsing_res_list` at the item root.
//! - `markdown.text` (preferred), falling back to
//!   `prunedResult.markdown.text`. When that's missing too, we synthesise
//!   the page text by joining `block_content` in `block_order` so the
//!   right panel still has something to show.
//! - `prunedResult.page_size` (or `pageSize`) for page width/height, then
//!   the serving envelope's `dataInfo` (whose `pages[].width/height` are the
//!   pixel dimensions of the page images the *server* rendered — exactly the
//!   coordinate space `block_bbox` lives in). Those two are the only real
//!   *measurements* of that space the format offers. When neither is present
//!   the size is inferred once for the whole document from the bbox extent
//!   and every affected page is flagged `dimensions_approximate` — see
//!   [`resolve_document_dimensions`].
//!
//! ## Why the `inputImage` / `outputImages` echoes are not a size source
//!
//! They look authoritative and are not. The hosted PaddleOCR-VL API caps the
//! images it echoes back at 2000px on the long side while running layout on
//! a larger internal render, so their header describes a downscaled preview,
//! *not* the space `block_bbox` lives in. On a real 88-page export (TNA
//! `FO 17/1007`, A3 landscape scans) every echo came back 2000×1413 while
//! the bboxes on the same pages ran out to x=2145 — a ~9% systematic error.
//! Worse, it is an undetectable one: the echo keeps the page's aspect ratio
//! exactly, so a mapping built from it sails through the canvas overlay's
//! isotropy check and draws a confidently misplaced highlight. Reading them
//! (inline base64 or by URL) was strictly worse than admitting we don't know
//! the size, so this module does neither.
//!
//! All output page indices are **1-based**, matching the rest of the
//! `RecognizedPages` store.
use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutBlock {
    pub label: String,
    pub text: String,
    pub bbox: [f64; 4],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polygon: Option<Vec<[f64; 2]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutPage {
    pub index: u32,
    pub width: f64,
    pub height: f64,
    pub blocks: Vec<LayoutBlock>,
    /// True when `width`/`height` were *inferred* from the document's bbox
    /// extent rather than measured from `page_size` / `dataInfo`.
    ///
    /// Consumers must not read an inferred pair as two independent numbers.
    /// The inference is reliable in one respect only — the long side, taken
    /// across the whole document — while the short side is whatever content
    /// happened to reach furthest down the page, so the *ratio* of the two
    /// carries no information. The canvas overlay therefore maps an
    /// approximate page with a single long-side scale factor and skips its
    /// aspect-ratio guard, which would otherwise be measuring noise.
    #[serde(default)]
    pub dimensions_approximate: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutDocument {
    /// `"paddle"` for now. Reserved so the same `LayoutDocument` can later
    /// describe GLM-OCR or other providers (see plan §14).
    pub source: String,
    pub pages: Vec<LayoutPage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageText {
    pub page: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaddleJsonPreflightReport {
    pub page_count: u32,
    pub block_count: u32,
    /// Sorted by label for deterministic UI ordering. `BTreeMap` is enough
    /// here — newspaper exports rarely exceed a dozen distinct labels.
    pub label_counts: BTreeMap<String, u32>,
    /// Raw `model_settings` blob if present, otherwise `null`. The UI just
    /// renders the keys; we don't try to interpret them.
    pub model_settings: serde_json::Value,
    /// Pulled out of `model_settings.markdown_ignore_labels` (or
    /// `markdownIgnoreLabels`) so the UI can call it out specifically.
    pub markdown_ignore_labels: Vec<String>,
    pub has_parsing_results: bool,
    pub has_block_bbox: bool,
    pub has_block_order: bool,
    pub has_polygon_points: bool,
    pub has_markdown: bool,
    pub has_images: bool,
    pub has_output_images: bool,
    /// 1-based indices (page position, not `LayoutPage.index`) of pages
    /// whose width/height were inferred rather than measured — the same set
    /// as `document.pages[i].dimensions_approximate`, hoisted here so the
    /// import dialog can report it before anything is written to the store.
    pub estimated_dimension_pages: Vec<u32>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaddleJsonImport {
    pub preflight: PaddleJsonPreflightReport,
    pub document: LayoutDocument,
    pub page_texts: Vec<PageText>,
}

pub fn analyze_path(path: &Path) -> AppResult<PaddleJsonImport> {
    let bytes = std::fs::read(path)
        .map_err(|e| AppError::Internal(format!("read {}: {e}", path.display())))?;
    let root: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(root) => root,
        Err(json_err) => {
            serde_json::Value::Array(parse_jsonl_bytes(&bytes).map_err(|jsonl_err| {
                AppError::Internal(format!(
                    "parse {} as JSON/JSONL: JSON: {json_err}; JSONL: {jsonl_err}",
                    path.display()
                ))
            })?)
        }
    };
    analyze_value(root)
}

pub fn analyze_value(root: serde_json::Value) -> AppResult<PaddleJsonImport> {
    let pages_raw = extract_pages_array(&root)?;
    let model_settings = extract_model_settings(&root, &pages_raw);
    let markdown_ignore_labels = extract_ignore_labels(&model_settings);
    // The serving envelope's `dataInfo` lives next to `layoutParsingResults`,
    // so page items unwrapped from that array no longer carry it — it has to
    // be captured here and index-matched back to the pages.
    let root_data_info = extract_data_info(&root);

    let mut parsed_pages: Vec<ParsedPage> = Vec::with_capacity(pages_raw.len());
    let mut page_texts = Vec::with_capacity(pages_raw.len());
    let mut label_counts: BTreeMap<String, u32> = BTreeMap::new();
    let mut block_count = 0u32;
    let mut any_parsing = false;
    let mut any_bbox = false;
    let mut any_order = false;
    let mut any_polygon = false;
    let mut any_markdown = false;
    let mut any_images = false;
    let mut any_output_images = false;
    let mut missing_dim_pages: Vec<u32> = Vec::new();

    for (idx, page_value) in pages_raw.iter().enumerate() {
        let page_index = (idx + 1) as u32;
        let mut parsed = parse_page(page_index, page_value, root_data_info.as_ref());

        block_count += parsed.blocks.len() as u32;
        for block in &parsed.blocks {
            *label_counts.entry(block.label.clone()).or_insert(0) += 1;
        }
        any_parsing |= parsed.had_parsing_list;
        any_bbox |= parsed.had_block_bbox;
        any_order |= parsed.had_block_order;
        any_polygon |= parsed.had_polygon;
        any_markdown |= parsed.had_markdown_text;
        any_images |= parsed.had_markdown_images;
        any_output_images |= parsed.had_output_images;
        if !parsed.had_explicit_dimensions {
            missing_dim_pages.push(page_index);
        }

        page_texts.push(PageText {
            page: page_index,
            text: std::mem::take(&mut parsed.text),
        });
        parsed_pages.push(parsed);
    }
    // Deliberately after the loop: a page's own bbox extent is a poor
    // stand-in for its size, but the extent seen across the *document* is a
    // good one, and no page can be sized until every page has been read.
    let layout_pages = resolve_document_dimensions(parsed_pages);

    let mut warnings: Vec<String> = Vec::new();
    if pages_raw.is_empty() {
        warnings
            .push(crate::tr!("JSON 中没有任何页面数据", "The JSON contains no page data").into());
    }
    if !any_parsing {
        warnings.push(
            crate::tr!(
                "未找到 parsing_res_list，无法按区块解析版式",
                "No parsing_res_list found — the layout cannot be parsed block by block"
            )
            .into(),
        );
    }
    if !any_bbox {
        warnings.push(
            crate::tr!(
                "缺少 block_bbox，无法按位置重建版式 PDF",
                "block_bbox is missing — the layout PDF cannot be rebuilt by position"
            )
            .into(),
        );
    }
    if !any_order {
        warnings.push(
            crate::tr!(
                "缺少 block_order，重建时将按 JSON 内的顺序排列",
                "block_order is missing — blocks keep the order they have in the JSON"
            )
            .into(),
        );
    }
    if !any_polygon {
        warnings.push(
            crate::tr!(
                "缺少 block_polygon_points，将退回矩形 bbox 渲染",
                "block_polygon_points is missing — falling back to rectangular bboxes"
            )
            .into(),
        );
    }
    if !any_markdown && !any_parsing {
        warnings.push(
            crate::tr!(
                "既无 markdown.text 也无 parsing_res_list，导出文本将为空",
                "Neither markdown.text nor parsing_res_list is present — the exported text will be empty"
            )
            .into(),
        );
    }
    if let Some(warning) = missing_dimensions_warning(&missing_dim_pages) {
        warnings.push(warning);
    }

    let preflight = PaddleJsonPreflightReport {
        page_count: pages_raw.len() as u32,
        block_count,
        label_counts,
        model_settings,
        markdown_ignore_labels,
        has_parsing_results: any_parsing,
        has_block_bbox: any_bbox,
        has_block_order: any_order,
        has_polygon_points: any_polygon,
        has_markdown: any_markdown,
        has_images: any_images,
        has_output_images: any_output_images,
        estimated_dimension_pages: missing_dim_pages,
        warnings,
    };

    Ok(PaddleJsonImport {
        preflight,
        document: LayoutDocument {
            source: "paddle".to_string(),
            pages: layout_pages,
        },
        page_texts,
    })
}

/// Percentage added to an inferred extent so a block flush with the page
/// edge doesn't end up sized to exactly the page (which renders at width 0
/// in the layout PDF export). Applied once, to the document-level figure —
/// never per page, which is what made the old estimate swing.
const EXTENT_PADDING: f64 = 0.02;

/// Turns parsed pages into [`LayoutPage`]s, inferring a size for every page
/// that carried no measured one.
///
/// The inference rests on one property of the producers: a document is
/// rendered server-side at a single scale (PaddleOCR-VL renders PDF pages
/// at 2×, i.e. 144 DPI), so every page of a document lands in the same
/// coordinate space. Two consequences:
///
/// 1. The **longest bbox extent seen anywhere in the document** is a far
///    better estimate of that space's long side than any single page's own
///    extent: a page whose text stops halfway down no longer shrinks its own
///    page, because some other page reached the margin. On the `FO 17/1007`
///    export the per-page estimate missed the true page shape by anywhere
///    from −49% to +88%.
/// 2. Orientation buckets share their evidence. A portrait page's height
///    and a landscape page's width measure the same quantity — the render
///    scale times the paper's long edge — so both are pooled, and the
///    result is handed back per page in that page's own orientation.
///
/// Both sides come out as *lower bounds*: content stops short of the paper's
/// edge, so the figures are systematically small (2273×1645 against a true
/// 2382×1684 on the file above). That is why every inferred page is flagged
/// `dimensions_approximate`, and why the canvas overlay treats the pair as
/// two bounds on one scale factor rather than as a page shape.
///
/// Known limitation: a document mixing *page sizes* (not merely
/// orientations) shares one estimate across all of them, so the smaller
/// pages come out over-sized. Mixed orientations are handled; mixed sizes
/// are rare in scanned archival material and would need per-page evidence
/// this format doesn't carry.
fn resolve_document_dimensions(parsed: Vec<ParsedPage>) -> Vec<LayoutPage> {
    let pad = |v: f64| {
        if v > 0.0 {
            v * (1.0 + EXTENT_PADDING)
        } else {
            v
        }
    };

    let mut long_side = 0.0_f64;
    let mut short_side = 0.0_f64;
    for page in &parsed {
        let (long, short) = if page.width >= page.height {
            (page.width, page.height)
        } else {
            (page.height, page.width)
        };
        if page.had_explicit_dimensions {
            // A measured page pins the render scale exactly: no padding, and
            // it outranks any content extent from the same document.
            long_side = long_side.max(long);
            short_side = short_side.max(short);
            continue;
        }
        long_side = long_side.max(pad(long));
        short_side = short_side.max(pad(short));
    }

    parsed
        .into_iter()
        .enumerate()
        .map(|(idx, page)| {
            let index = (idx + 1) as u32;
            if page.had_explicit_dimensions {
                return LayoutPage {
                    index,
                    width: page.width,
                    height: page.height,
                    blocks: page.blocks,
                    dimensions_approximate: false,
                };
            }
            // Orientation is this module's only guess — it reads it off the
            // page's own block extents. The canvas re-derives it from the
            // bitmap and is built not to care if the two disagree.
            let (width, height) = if page.width >= page.height {
                (long_side, short_side)
            } else {
                (short_side, long_side)
            };
            LayoutPage {
                index,
                width,
                height,
                blocks: page.blocks,
                dimensions_approximate: true,
            }
        })
        .collect()
}

/// Formats the "N pages have no measured size" warning, or `None` when the
/// list is empty.
fn missing_dimensions_warning(missing_dim_pages: &[u32]) -> Option<String> {
    if missing_dim_pages.is_empty() {
        return None;
    }
    let preview = missing_dim_pages
        .iter()
        .take(5)
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join("、");
    let suffix = if missing_dim_pages.len() > 5 {
        "…"
    } else {
        ""
    };
    Some(crate::trf!(
        "{} 页未提供页面尺寸，已按整份文件的 bbox 外延推算，区块定位为近似（第 {}{} 页）",
        "{} pages carry no page size — inferred from the document's bbox extent, so block positions are approximate (pages {}{})",
        missing_dim_pages.len(),
        preview,
        suffix,
    ))
}

fn parse_jsonl_bytes(bytes: &[u8]) -> Result<Vec<serde_json::Value>, String> {
    let source = std::str::from_utf8(bytes).map_err(|e| format!("utf8: {e}"))?;
    let mut out = Vec::new();
    for (idx, line) in source.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value = serde_json::from_str(trimmed).map_err(|e| format!("line {}: {e}", idx + 1))?;
        out.push(value);
    }
    if out.is_empty() {
        return Err("no non-empty JSONL lines".into());
    }
    Ok(out)
}

fn extract_pages_array(root: &serde_json::Value) -> AppResult<Vec<serde_json::Value>> {
    if let Some(arr) = root.as_array() {
        return Ok(arr.clone());
    }
    if let Some(obj) = root.as_object() {
        for key in ["pages", "results"] {
            if let Some(arr) = obj.get(key).and_then(|v| v.as_array()) {
                return Ok(arr.clone());
            }
        }
        for key in ["layoutParsingResults", "layout_parsing_results"] {
            if let Some(arr) = obj.get(key).and_then(|v| v.as_array()) {
                if array_looks_like_pages(arr) {
                    return Ok(arr.clone());
                }
                return Ok(vec![serde_json::Value::Object(obj.clone())]);
            }
        }
        // `{ "result": { "layoutParsingResults": [...] } }` shape produced
        // by the v2 jobs endpoint when merged into one object per file.
        if let Some(inner) = obj.get("result").and_then(|v| v.as_object()) {
            for key in ["pages", "results"] {
                if let Some(arr) = inner.get(key).and_then(|v| v.as_array()) {
                    return Ok(arr.clone());
                }
            }
            for key in ["layoutParsingResults", "layout_parsing_results"] {
                if let Some(arr) = inner.get(key).and_then(|v| v.as_array()) {
                    if array_looks_like_pages(arr) {
                        return Ok(arr.clone());
                    }
                    return Ok(vec![serde_json::Value::Object(obj.clone())]);
                }
            }
        }
        // Fall back to treating the object itself as a single page so a
        // user accidentally exporting one page still sees something useful.
        if value_looks_like_page(root) || layout_results_array(root).is_some() {
            return Ok(vec![serde_json::Value::Object(obj.clone())]);
        }
    }
    Err(AppError::Internal(
        crate::tr!(
            "Paddle JSON 顶层既不是数组，也找不到 pages/results/layoutParsingResults 字段",
            "The Paddle JSON root is neither an array nor does it carry a pages / results / layoutParsingResults field"
        )
        .into(),
    ))
}

fn array_looks_like_pages(arr: &[serde_json::Value]) -> bool {
    arr.iter().any(value_looks_like_page)
}

fn value_looks_like_page(value: &serde_json::Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    obj.contains_key("prunedResult")
        || obj.contains_key("pruned_result")
        || obj.contains_key("parsing_res_list")
        || obj.contains_key("page_size")
        || obj.contains_key("pageSize")
        || obj.contains_key("page_width")
        || obj.contains_key("pageWidth")
}

fn layout_results_array(value: &serde_json::Value) -> Option<&Vec<serde_json::Value>> {
    let obj = value.as_object()?;
    for key in ["layoutParsingResults", "layout_parsing_results"] {
        if let Some(arr) = obj.get(key).and_then(|v| v.as_array()) {
            return Some(arr);
        }
    }
    if let Some(inner) = obj.get("result").and_then(|v| v.as_object()) {
        for key in ["layoutParsingResults", "layout_parsing_results"] {
            if let Some(arr) = inner.get(key).and_then(|v| v.as_array()) {
                return Some(arr);
            }
        }
    }
    None
}

fn layout_markdown_text(results: Option<&[serde_json::Value]>) -> Option<String> {
    let text = results?
        .iter()
        .filter_map(|item| {
            item.get("markdown")
                .and_then(|m| m.get("text"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn layout_markdown_images_present(results: &[serde_json::Value]) -> bool {
    results.iter().any(|item| {
        item.get("markdown")
            .and_then(|m| m.get("images"))
            .map(|v| match v {
                serde_json::Value::Object(o) => !o.is_empty(),
                serde_json::Value::Array(a) => !a.is_empty(),
                _ => false,
            })
            .unwrap_or(false)
    })
}

fn extract_model_settings(
    root: &serde_json::Value,
    pages: &[serde_json::Value],
) -> serde_json::Value {
    let keys = ["modelSettings", "model_settings"];
    if let Some(obj) = root.as_object() {
        for key in keys {
            if let Some(value) = obj.get(key) {
                if !value.is_null() {
                    return value.clone();
                }
            }
        }
        if let Some(inner) = obj.get("result").and_then(|v| v.as_object()) {
            for key in keys {
                if let Some(value) = inner.get(key) {
                    if !value.is_null() {
                        return value.clone();
                    }
                }
            }
        }
    }
    for page in pages {
        if let Some(page_obj) = page.as_object() {
            for key in keys {
                if let Some(value) = page_obj.get(key) {
                    if !value.is_null() {
                        return value.clone();
                    }
                }
            }
            if let Some(pruned) = page_obj
                .get("prunedResult")
                .or_else(|| page_obj.get("pruned_result"))
                .and_then(|v| v.as_object())
            {
                for key in keys {
                    if let Some(value) = pruned.get(key) {
                        if !value.is_null() {
                            return value.clone();
                        }
                    }
                }
            }
        }
    }
    serde_json::Value::Null
}

fn extract_ignore_labels(model_settings: &serde_json::Value) -> Vec<String> {
    let Some(obj) = model_settings.as_object() else {
        return Vec::new();
    };
    for key in ["markdownIgnoreLabels", "markdown_ignore_labels"] {
        if let Some(arr) = obj.get(key).and_then(|v| v.as_array()) {
            return arr
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
        }
    }
    Vec::new()
}

struct ParsedPage {
    width: f64,
    height: f64,
    blocks: Vec<LayoutBlock>,
    text: String,
    had_parsing_list: bool,
    had_block_bbox: bool,
    had_block_order: bool,
    had_polygon: bool,
    had_markdown_text: bool,
    had_markdown_images: bool,
    had_output_images: bool,
    had_explicit_dimensions: bool,
}

fn parse_page(
    page_index: u32,
    value: &serde_json::Value,
    root_data_info: Option<&serde_json::Value>,
) -> ParsedPage {
    let idx = (page_index as usize).saturating_sub(1);
    let pruned = value
        .get("prunedResult")
        .or_else(|| value.get("pruned_result"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let explicit_parsing_list = pruned
        .get("parsing_res_list")
        .or_else(|| value.get("parsing_res_list"))
        .and_then(|v| v.as_array())
        .cloned();
    let layout_results = layout_results_array(value).cloned();
    let had_parsing_list = explicit_parsing_list.is_some();

    let mut blocks: Vec<LayoutBlock> = Vec::new();
    let mut had_block_bbox = false;
    let mut had_block_order = false;
    let mut had_polygon = false;
    if let Some(list) = explicit_parsing_list.as_ref().or(layout_results.as_ref()) {
        for raw_block in list {
            let Some(block) = parse_block(raw_block) else {
                continue;
            };
            had_block_bbox |= !block.bbox.iter().all(|v| *v == 0.0);
            had_block_order |= block.order.is_some();
            had_polygon |= block.polygon.is_some();
            blocks.push(block);
        }
    }

    // Block order is optional; when present, sort ascending so the
    // synthesised page text and the downstream layout exporter agree on
    // reading sequence. When absent, leave JSON-array order alone.
    if had_block_order {
        blocks.sort_by(|a, b| match (a.order, b.order) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        });
    }

    let markdown_obj = pruned
        .get("markdown")
        .or_else(|| value.get("markdown"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let markdown_text = markdown_obj
        .get("text")
        .and_then(|v| v.as_str())
        .map(String::from);
    let layout_markdown_text = layout_markdown_text(layout_results.as_deref());
    let had_markdown_text = markdown_text.as_ref().is_some_and(|s| !s.is_empty())
        || layout_markdown_text.as_ref().is_some_and(|s| !s.is_empty());
    let had_markdown_images = markdown_obj
        .get("images")
        .map(|v| match v {
            serde_json::Value::Object(o) => !o.is_empty(),
            serde_json::Value::Array(a) => !a.is_empty(),
            _ => false,
        })
        .unwrap_or(false)
        || layout_results
            .as_deref()
            .is_some_and(layout_markdown_images_present);

    let had_output_images = value
        .get("outputImages")
        .or_else(|| value.get("output_images"))
        .map(|v| match v {
            serde_json::Value::Object(o) => !o.is_empty(),
            serde_json::Value::Array(a) => !a.is_empty(),
            _ => false,
        })
        .unwrap_or(false);

    // Page dimensions, measured sources only:
    // 1. Explicit page-size fields (`page_size` / `pageSize` / …).
    // 2. `dataInfo` from the serving envelope (per row, then the root): its
    //    `pages[].width/height` are the pixel size of the page image the
    //    server itself rendered from the PDF, i.e. the exact coordinate
    //    space of every `block_bbox`.
    //
    // Neither present means this page's size is simply not in the file. The
    // raw bbox extent goes out as a *placeholder* that `analyze_value`
    // replaces with a document-level figure once every page has been read —
    // see [`resolve_document_dimensions`]. The `inputImage` / `outputImages`
    // echoes are not consulted; the module docs explain why they cannot be.
    let (width, height, had_explicit_dimensions) = extract_dimensions(&pruned, value)
        .or_else(|| {
            extract_data_info(value)
                .as_ref()
                .or(root_data_info)
                .and_then(|info| dims_from_data_info(info, idx))
                .map(|(w, h)| (w, h, true))
        })
        .unwrap_or_else(|| {
            let (w, h) = bbox_extent(&blocks);
            (w, h, false)
        });

    // Page text: prefer Paddle's own markdown rendering, fall back to the
    // block_content concatenation. The latter loses the markdown table /
    // image syntax Paddle would have produced, but it keeps the right
    // panel useful when the markdown branch is missing.
    let text = markdown_text.or(layout_markdown_text).unwrap_or_else(|| {
        blocks
            .iter()
            .filter(|b| !b.text.trim().is_empty())
            .map(|b| b.text.clone())
            .collect::<Vec<_>>()
            .join("\n\n")
    });

    ParsedPage {
        width,
        height,
        blocks,
        text,
        had_parsing_list,
        had_block_bbox,
        had_block_order,
        had_polygon,
        had_markdown_text,
        had_markdown_images,
        had_output_images,
        had_explicit_dimensions,
    }
}

fn parse_block(raw: &serde_json::Value) -> Option<LayoutBlock> {
    let obj = raw.as_object()?;
    let markdown_text = obj
        .get("markdown")
        .and_then(|m| m.get("text"))
        .and_then(|v| v.as_str());
    let label = obj
        .get("block_label")
        .or_else(|| obj.get("blockLabel"))
        .and_then(|v| v.as_str())
        .or_else(|| markdown_text.map(|_| "text"))
        .unwrap_or("")
        .to_string();
    let text = obj
        .get("block_content")
        .or_else(|| obj.get("blockContent"))
        .and_then(|v| v.as_str())
        .or(markdown_text)
        .unwrap_or("")
        .to_string();
    let bbox = obj
        .get("block_bbox")
        .or_else(|| obj.get("blockBbox"))
        .and_then(parse_bbox)
        .unwrap_or([0.0, 0.0, 0.0, 0.0]);
    let polygon = obj
        .get("block_polygon_points")
        .or_else(|| obj.get("blockPolygonPoints"))
        .and_then(parse_polygon);
    let order = obj
        .get("block_order")
        .or_else(|| obj.get("blockOrder"))
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok());
    let image_ref = obj
        .get("block_image")
        .or_else(|| obj.get("blockImage"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| extract_img_src(&text));

    if label.is_empty()
        && text.trim().is_empty()
        && bbox.iter().all(|v| *v == 0.0)
        && polygon.is_none()
    {
        return None;
    }

    Some(LayoutBlock {
        label,
        text,
        bbox,
        polygon,
        order,
        image_ref,
    })
}

fn extract_img_src(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let img_pos = lower.find("<img")?;
    let tail = &text[img_pos..];
    let lower_tail = &lower[img_pos..];
    let src_pos = lower_tail.find("src=")?;
    let after_src = &tail[src_pos + 4..];
    let mut chars = after_src.trim_start().chars();
    let quote = chars.next()?;
    if quote == '"' || quote == '\'' {
        let rest = chars.as_str();
        let end = rest.find(quote)?;
        let src = rest[..end].trim();
        return (!src.is_empty()).then(|| src.to_string());
    }
    let rest = after_src.trim_start();
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '>')
        .unwrap_or(rest.len());
    let src = rest[..end].trim();
    (!src.is_empty()).then(|| src.to_string())
}

fn parse_bbox(value: &serde_json::Value) -> Option<[f64; 4]> {
    if let Some(arr) = value.as_array() {
        if arr.len() == 4 {
            let mut out = [0.0_f64; 4];
            for (slot, item) in out.iter_mut().zip(arr.iter()) {
                *slot = item.as_f64()?;
            }
            return Some(out);
        }
    }
    if let Some(obj) = value.as_object() {
        let x0 = obj
            .get("x0")
            .or_else(|| obj.get("x_min"))
            .and_then(|v| v.as_f64())?;
        let y0 = obj
            .get("y0")
            .or_else(|| obj.get("y_min"))
            .and_then(|v| v.as_f64())?;
        let x1 = obj
            .get("x1")
            .or_else(|| obj.get("x_max"))
            .and_then(|v| v.as_f64())?;
        let y1 = obj
            .get("y1")
            .or_else(|| obj.get("y_max"))
            .and_then(|v| v.as_f64())?;
        return Some([x0, y0, x1, y1]);
    }
    None
}

fn parse_polygon(value: &serde_json::Value) -> Option<Vec<[f64; 2]>> {
    let arr = value.as_array()?;
    if arr.is_empty() {
        return None;
    }
    // Shape A: `[[x, y], [x, y], ...]`
    if arr
        .iter()
        .all(|p| p.as_array().is_some_and(|inner| inner.len() == 2))
    {
        let mut out: Vec<[f64; 2]> = Vec::with_capacity(arr.len());
        for point in arr {
            let inner = point.as_array().unwrap();
            let x = inner[0].as_f64()?;
            let y = inner[1].as_f64()?;
            out.push([x, y]);
        }
        return Some(out);
    }
    // Shape B: flat `[x, y, x, y, ...]`
    if arr.iter().all(|p| p.is_number()) && arr.len() % 2 == 0 {
        let mut out: Vec<[f64; 2]> = Vec::with_capacity(arr.len() / 2);
        let mut iter = arr.iter();
        while let (Some(x), Some(y)) = (iter.next(), iter.next()) {
            out.push([x.as_f64()?, y.as_f64()?]);
        }
        return Some(out);
    }
    None
}

fn extract_dimensions(
    pruned: &serde_json::Value,
    page: &serde_json::Value,
) -> Option<(f64, f64, bool)> {
    for src in [pruned, page] {
        if let Some(size) = src
            .get("page_size")
            .or_else(|| src.get("pageSize"))
            .or_else(|| src.get("input_size"))
        {
            if let Some(arr) = size.as_array() {
                if arr.len() >= 2 {
                    let w = arr[0].as_f64();
                    let h = arr[1].as_f64();
                    if let (Some(w), Some(h)) = (w, h) {
                        if w > 0.0 && h > 0.0 {
                            return Some((w, h, true));
                        }
                    }
                }
            }
            if let Some(obj) = size.as_object() {
                let w = obj
                    .get("width")
                    .or_else(|| obj.get("w"))
                    .and_then(|v| v.as_f64());
                let h = obj
                    .get("height")
                    .or_else(|| obj.get("h"))
                    .and_then(|v| v.as_f64());
                if let (Some(w), Some(h)) = (w, h) {
                    if w > 0.0 && h > 0.0 {
                        return Some((w, h, true));
                    }
                }
            }
        }
        let w = src.get("page_width").or_else(|| src.get("pageWidth"));
        let h = src.get("page_height").or_else(|| src.get("pageHeight"));
        if let (Some(w), Some(h)) = (w.and_then(|v| v.as_f64()), h.and_then(|v| v.as_f64())) {
            if w > 0.0 && h > 0.0 {
                return Some((w, h, true));
            }
        }
    }
    None
}

/// Finds the serving envelope's `dataInfo` on a value: either directly on
/// the object or under its `result` wrapper (the JSONL row shape).
fn extract_data_info(value: &serde_json::Value) -> Option<serde_json::Value> {
    let obj = value.as_object()?;
    for key in ["dataInfo", "data_info"] {
        if let Some(info) = obj.get(key) {
            if info.is_object() {
                return Some(info.clone());
            }
        }
    }
    if let Some(inner) = obj.get("result").and_then(|v| v.as_object()) {
        for key in ["dataInfo", "data_info"] {
            if let Some(info) = inner.get(key) {
                if info.is_object() {
                    return Some(info.clone());
                }
            }
        }
    }
    None
}

/// Reads page dimensions out of a serving `dataInfo` object.
///
/// Two shapes exist (see PaddleX `serving/infra/models.py`): `ImageInfo`
/// (`{width, height, type: "image"}`) and `PDFInfo` / `TIFFInfo`
/// (`{numPages, pages: [{width, height}], type}`). The widths/heights are
/// taken from the numpy arrays the server actually ran on
/// (`image.shape[1]` / `image.shape[0]`), so for a PDF they are the pixel
/// size of the *server-side render* — the coordinate space of `block_bbox`.
///
/// `idx` is the 0-based page position. A single-entry `pages` list is
/// treated as "this row's own page" regardless of `idx`, because a JSONL
/// row carrying its own `dataInfo` describes only itself while the row's
/// global position can be anywhere in the requested range.
fn dims_from_data_info(info: &serde_json::Value, idx: usize) -> Option<(f64, f64)> {
    let obj = info.as_object()?;
    let read_dims = |o: &serde_json::Map<String, serde_json::Value>| -> Option<(f64, f64)> {
        let w = o.get("width").and_then(|v| v.as_f64())?;
        let h = o.get("height").and_then(|v| v.as_f64())?;
        if w > 0.0 && h > 0.0 {
            Some((w, h))
        } else {
            None
        }
    };
    if let Some(pages) = obj.get("pages").and_then(|v| v.as_array()) {
        let entry = if pages.len() == 1 {
            pages.first()
        } else {
            pages.get(idx)
        };
        return entry.and_then(|p| p.as_object()).and_then(read_dims);
    }
    read_dims(obj)
}

/// The outer extent of a page's blocks: a lower bound on the page's size,
/// and on its own a bad estimate of it (see [`resolve_document_dimensions`]
/// for what is done with it instead). Unpadded — padding is applied once,
/// document-wide.
fn bbox_extent(blocks: &[LayoutBlock]) -> (f64, f64) {
    let mut max_x = 0.0_f64;
    let mut max_y = 0.0_f64;
    for block in blocks {
        max_x = max_x.max(block.bbox[2]);
        max_y = max_y.max(block.bbox[3]);
        if let Some(polygon) = block.polygon.as_ref() {
            for [x, y] in polygon {
                max_x = max_x.max(*x);
                max_y = max_y.max(*y);
            }
        }
    }
    (max_x, max_y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_two_pages() -> serde_json::Value {
        json!([
            {
                "prunedResult": {
                    "page_size": [2000, 3000],
                    "model_settings": {
                        "useLayoutDetection": true,
                        "markdownIgnoreLabels": ["page_number", "footer"]
                    },
                    "parsing_res_list": [
                        {
                            "block_label": "doc_title",
                            "block_content": "南洋日报",
                            "block_bbox": [100, 80, 1900, 220],
                            "block_order": 1
                        },
                        {
                            "block_label": "text",
                            "block_content": "本报讯 ...",
                            "block_bbox": [100, 260, 1900, 1200],
                            "block_order": 2,
                            "block_polygon_points": [[100, 260], [1900, 260], [1900, 1200], [100, 1200]]
                        },
                        {
                            "block_label": "page_number",
                            "block_content": "1",
                            "block_bbox": [950, 2900, 1050, 2950],
                            "block_order": 3
                        }
                    ],
                    "markdown": {
                        "text": "# 南洋日报\n\n本报讯 ...",
                        "images": { "img-0.jpg": "..." }
                    }
                },
                "outputImages": { "layout.png": "..." }
            },
            {
                "prunedResult": {
                    "page_size": { "width": 2000, "height": 3000 },
                    "parsing_res_list": [
                        {
                            "block_label": "text",
                            "block_content": "续版正文。",
                            "block_bbox": [100, 100, 1900, 1500],
                            "block_order": 1
                        },
                        {
                            "block_label": "vision_footnote",
                            "block_content": "注：本期...",
                            "block_bbox": [100, 2700, 1900, 2850],
                            "block_order": 2
                        }
                    ],
                    "markdown": { "text": "续版正文。\n\n*注：本期...*" }
                }
            }
        ])
    }

    #[test]
    fn parses_typical_two_page_export() {
        let import = analyze_value(sample_two_pages()).unwrap();
        assert_eq!(import.preflight.page_count, 2);
        assert_eq!(import.preflight.block_count, 5);
        assert!(import.preflight.has_parsing_results);
        assert!(import.preflight.has_block_bbox);
        assert!(import.preflight.has_block_order);
        assert!(import.preflight.has_polygon_points);
        assert!(import.preflight.has_markdown);
        assert!(import.preflight.has_images);
        assert!(import.preflight.has_output_images);
        assert_eq!(import.preflight.label_counts.get("text").copied(), Some(2));
        assert_eq!(
            import.preflight.label_counts.get("doc_title").copied(),
            Some(1)
        );
        assert_eq!(
            import.preflight.markdown_ignore_labels,
            vec!["page_number".to_string(), "footer".to_string()]
        );
        assert_eq!(import.document.pages.len(), 2);
        let page1 = &import.document.pages[0];
        assert_eq!(page1.width, 2000.0);
        assert_eq!(page1.height, 3000.0);
        assert_eq!(page1.blocks.len(), 3);
        assert_eq!(page1.blocks[0].label, "doc_title");
        assert_eq!(page1.blocks[1].label, "text");
        assert!(page1.blocks[1].polygon.is_some());
        assert_eq!(import.page_texts.len(), 2);
        assert!(import.page_texts[0].text.starts_with("# 南洋日报"));
    }

    #[test]
    fn falls_back_to_object_root_with_layout_parsing_results() {
        let root = json!({
            "result": {
                "layoutParsingResults": [
                    {
                        "prunedResult": {
                            "parsing_res_list": [
                                { "block_label": "text", "block_content": "hi", "block_bbox": [0, 0, 10, 10] }
                            ],
                            "markdown": { "text": "hi" }
                        }
                    }
                ]
            }
        });
        let import = analyze_value(root).unwrap();
        assert_eq!(import.preflight.page_count, 1);
        assert_eq!(import.page_texts[0].text, "hi");
    }

    #[test]
    fn treats_layout_parsing_result_items_as_one_page_when_they_are_blocks() {
        let root = json!({
            "result": {
                "layoutParsingResults": [
                    { "markdown": { "text": "正文 A" } },
                    { "markdown": { "text": "脚注 B" } }
                ]
            }
        });
        let import = analyze_value(root).unwrap();
        assert_eq!(import.preflight.page_count, 1);
        assert_eq!(import.page_texts[0].text, "正文 A\n\n脚注 B");
        assert_eq!(import.preflight.block_count, 2);
        assert!(import.preflight.has_markdown);
    }

    #[test]
    fn accepts_jsonl_file_with_one_result_object_per_page() {
        use std::io::Write;

        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            file,
            "{}",
            json!({ "result": { "layoutParsingResults": [
                { "markdown": { "text": "第一页正文" } }
            ]}})
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({ "result": { "layoutParsingResults": [
                { "markdown": { "text": "第二页正文" } },
                { "markdown": { "text": "第二页脚注" } }
            ]}})
        )
        .unwrap();

        let import = analyze_path(file.path()).unwrap();
        assert_eq!(import.preflight.page_count, 2);
        assert_eq!(import.page_texts[0].text, "第一页正文");
        assert_eq!(import.page_texts[1].text, "第二页正文\n\n第二页脚注");
    }

    #[test]
    fn warns_when_parsing_list_or_bbox_missing() {
        let root = json!([{ "markdown": { "text": "only markdown" } }]);
        let import = analyze_value(root).unwrap();
        assert_eq!(import.preflight.page_count, 1);
        assert_eq!(import.preflight.block_count, 0);
        assert!(!import.preflight.has_parsing_results);
        assert!(!import.preflight.has_block_bbox);
        assert!(import
            .preflight
            .warnings
            .iter()
            .any(|w| w.contains("parsing_res_list")));
        assert!(import
            .preflight
            .warnings
            .iter()
            .any(|w| w.contains("block_bbox")));
        assert_eq!(import.page_texts[0].text, "only markdown");
    }

    #[test]
    fn synthesises_page_text_from_blocks_when_markdown_missing() {
        let root = json!([{
            "prunedResult": {
                "page_size": [800, 1000],
                "parsing_res_list": [
                    { "block_label": "text", "block_content": "段落 A", "block_bbox": [0, 0, 100, 100], "block_order": 2 },
                    { "block_label": "text", "block_content": "段落 B", "block_bbox": [0, 0, 100, 100], "block_order": 1 }
                ]
            }
        }]);
        let import = analyze_value(root).unwrap();
        assert_eq!(import.page_texts[0].text, "段落 B\n\n段落 A");
        // Sorted by block_order, so the LayoutDocument matches the synthesised text.
        let page = &import.document.pages[0];
        assert_eq!(page.blocks[0].text, "段落 B");
        assert_eq!(page.blocks[1].text, "段落 A");
    }

    #[test]
    fn estimates_page_dimensions_when_missing() {
        let root = json!([{
            "prunedResult": {
                "parsing_res_list": [
                    { "block_label": "text", "block_content": "x", "block_bbox": [0, 0, 1000, 1500] }
                ],
                "markdown": { "text": "x" }
            }
        }]);
        let import = analyze_value(root).unwrap();
        let page = &import.document.pages[0];
        assert!(page.width >= 1000.0);
        assert!(page.height >= 1500.0);
        assert!(import
            .preflight
            .warnings
            .iter()
            .any(|w| w.contains("页面尺寸")));
    }

    #[test]
    fn reads_dimensions_from_row_level_data_info() {
        // A JSONL row: its own `result.dataInfo` describes only this page
        // (single-entry `pages`), regardless of the row's global position.
        let rows = json!([
            { "result": {
                "layoutParsingResults": [{ "prunedResult": {
                    "parsing_res_list": [
                        { "block_label": "text", "block_content": "甲", "block_bbox": [10, 10, 900, 500] }
                    ]
                }}],
                "dataInfo": { "numPages": 1, "pages": [{ "width": 1654, "height": 2339 }], "type": "pdf" }
            }},
            { "result": {
                "layoutParsingResults": [{ "prunedResult": {
                    "parsing_res_list": [
                        { "block_label": "text", "block_content": "乙", "block_bbox": [10, 10, 800, 400] }
                    ]
                }}],
                "dataInfo": { "numPages": 1, "pages": [{ "width": 1240, "height": 1754 }], "type": "pdf" }
            }}
        ]);
        let import = analyze_value(rows).unwrap();
        assert_eq!(import.document.pages[0].width, 1654.0);
        assert_eq!(import.document.pages[0].height, 2339.0);
        assert_eq!(import.document.pages[1].width, 1240.0);
        assert_eq!(import.document.pages[1].height, 1754.0);
        assert!(!import
            .preflight
            .warnings
            .iter()
            .any(|w| w.contains("页面尺寸")));
    }

    #[test]
    fn reads_dimensions_from_root_data_info_by_page_index() {
        // The serving envelope: `dataInfo.pages` sits next to
        // `layoutParsingResults` and is index-matched to the pages.
        let root = json!({ "result": {
            "layoutParsingResults": [
                { "prunedResult": { "parsing_res_list": [
                    { "block_label": "text", "block_content": "甲", "block_bbox": [10, 10, 900, 500] }
                ]}},
                { "prunedResult": { "parsing_res_list": [
                    { "block_label": "text", "block_content": "乙", "block_bbox": [10, 10, 800, 400] }
                ]}}
            ],
            "dataInfo": {
                "numPages": 2,
                "pages": [
                    { "width": 1654, "height": 2339 },
                    { "width": 1240, "height": 1754 }
                ],
                "type": "pdf"
            }
        }});
        let import = analyze_value(root).unwrap();
        assert_eq!(import.document.pages.len(), 2);
        assert_eq!(import.document.pages[0].width, 1654.0);
        assert_eq!(import.document.pages[1].width, 1240.0);
    }

    #[test]
    fn reads_dimensions_from_image_data_info() {
        // Image input: `dataInfo` is a flat `ImageInfo`, no `pages` list.
        let root = json!({ "result": {
            "layoutParsingResults": [{ "prunedResult": { "parsing_res_list": [
                { "block_label": "text", "block_content": "甲", "block_bbox": [10, 10, 900, 500] }
            ]}}],
            "dataInfo": { "width": 3000, "height": 4000, "type": "image" }
        }});
        let import = analyze_value(root).unwrap();
        assert_eq!(import.document.pages[0].width, 3000.0);
        assert_eq!(import.document.pages[0].height, 4000.0);
    }

    #[test]
    fn explicit_page_size_beats_data_info() {
        let root = json!({ "result": {
            "layoutParsingResults": [{ "prunedResult": {
                "page_size": [2000, 3000],
                "parsing_res_list": [
                    { "block_label": "text", "block_content": "甲", "block_bbox": [10, 10, 900, 500] }
                ]
            }}],
            "dataInfo": { "width": 999, "height": 999, "type": "image" }
        }});
        let import = analyze_value(root).unwrap();
        assert_eq!(import.document.pages[0].width, 2000.0);
        assert_eq!(import.document.pages[0].height, 3000.0);
    }

    #[test]
    fn ignores_a_base64_input_image_echo() {
        // A 20×30 PNG inline on `inputImage`. Before this module stopped
        // reading echoes it would have become the page size; the echo is a
        // downscaled preview of the render, not the bbox space, so the page
        // must stay on the document-level inference and keep its warning.
        let mut png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&20u32.to_be_bytes());
        png.extend_from_slice(&30u32.to_be_bytes());
        png.extend_from_slice(&[8, 2, 0, 0, 0]);
        use base64::{engine::general_purpose::STANDARD, Engine};
        let root = json!([{
            "prunedResult": { "parsing_res_list": [
                { "block_label": "text", "block_content": "甲", "block_bbox": [1, 1, 15, 20] }
            ]},
            "inputImage": STANDARD.encode(&png)
        }]);
        let import = analyze_value(root).unwrap();
        assert_ne!(import.document.pages[0].width, 20.0);
        assert!(import.document.pages[0].dimensions_approximate);
        assert_eq!(import.preflight.estimated_dimension_pages, vec![1]);
        assert!(import
            .preflight
            .warnings
            .iter()
            .any(|w| w.contains("页面尺寸")));
    }

    #[test]
    fn ignores_a_url_input_image_echo() {
        let root = json!([{
            "prunedResult": { "parsing_res_list": [
                { "block_label": "text", "block_content": "甲", "block_bbox": [0, 0, 1000, 1500] }
            ]},
            "inputImage": "https://example.com/page.jpg?sig=abc"
        }]);
        let import = analyze_value(root).unwrap();
        assert!(import.document.pages[0].dimensions_approximate);
        assert!(import
            .preflight
            .warnings
            .iter()
            .any(|w| w.contains("页面尺寸")));
    }

    #[test]
    fn accepts_polygon_as_flat_number_array() {
        let root = json!([{
            "prunedResult": {
                "page_size": [800, 1000],
                "parsing_res_list": [
                    {
                        "block_label": "text",
                        "block_content": "x",
                        "block_bbox": [0, 0, 100, 100],
                        "block_polygon_points": [0, 0, 100, 0, 100, 100, 0, 100]
                    }
                ]
            }
        }]);
        let import = analyze_value(root).unwrap();
        let block = &import.document.pages[0].blocks[0];
        let polygon = block.polygon.as_ref().expect("polygon present");
        assert_eq!(polygon.len(), 4);
        assert_eq!(polygon[2], [100.0, 100.0]);
        assert!(import.preflight.has_polygon_points);
    }

    #[test]
    fn extracts_image_ref_from_html_img_src() {
        let root = json!([{
            "prunedResult": {
                "page_size": [800, 1000],
                "parsing_res_list": [
                    {
                        "block_label": "image",
                        "block_content": "<div><img src=\"imgs/photo.jpg\" /></div>",
                        "block_bbox": [0, 0, 100, 100]
                    }
                ]
            }
        }]);
        let import = analyze_value(root).unwrap();
        let block = &import.document.pages[0].blocks[0];
        assert_eq!(block.image_ref.as_deref(), Some("imgs/photo.jpg"));
    }

    #[test]
    fn rejects_top_level_string() {
        let err = analyze_value(json!("not an object")).unwrap_err();
        match err {
            AppError::Internal(msg) => {
                assert!(msg.contains("顶层"));
            }
            other => panic!("expected Internal, got {other:?}"),
        }
    }

    #[test]
    fn accepts_single_object_with_pruned_result() {
        let root = json!({
            "prunedResult": {
                "parsing_res_list": [
                    { "block_label": "text", "block_content": "solo", "block_bbox": [0, 0, 10, 10] }
                ],
                "markdown": { "text": "solo" }
            }
        });
        let import = analyze_value(root).unwrap();
        assert_eq!(import.preflight.page_count, 1);
        assert_eq!(import.page_texts[0].text, "solo");
    }

    // ---------------------------------------------------------------
    // Document-level dimension inference.
    //
    // The extents below are transcribed from a real PaddleOCR-VL 1.6 export
    // (TNA `FO 17/1007`, 88 A3 pages, no `page_size` and no `dataInfo`
    // anywhere). Its landscape pages are 1191×842pt and the server rendered
    // them at 2×, so `block_bbox` lives in a 2382×1684 space.
    //
    // That number is not in the file, and was not guessed: the export's own
    // `outputImages.layout_det_res` visualization is 2000×1413 and draws the
    // page's boxes down to y=1308 where the tallest bbox is y=1559, giving
    // 1559 × 1413 / 1308 = 1684 for the height and 1684 × 1191/842 = 2382
    // for the width. The point of these tests is how close the inference
    // gets to it with none of that available.
    // ---------------------------------------------------------------

    /// The true landscape render size the pages below were produced in.
    const REAL_RENDER: (f64, f64) = (2382.0, 1684.0);

    fn extent_page(max_x: f64, max_y: f64) -> serde_json::Value {
        json!({
            "prunedResult": { "parsing_res_list": [
                { "block_label": "header", "block_content": "TNA reference", "block_bbox": [2, 0, 649, 44] },
                { "block_label": "text", "block_content": "x", "block_bbox": [100, 100, max_x, max_y] }
            ]},
            // URL echoes exactly as the real export carries them — a 2000px
            // preview that must not become the page size.
            "inputImage": "https://pplines-online.bj.bcebos.com/x/input_img_0.jpg?authorization=sig",
            "outputImages": { "layout_det_res": "https://pplines-online.bj.bcebos.com/x/layout_det_res_0.jpg?authorization=sig" }
        })
    }

    /// Landscape extents from pages 1, 15, 21 and 88 of the real export.
    /// Page 15 is the pathological one: its content stops at y=1252, so its
    /// *own* extent claims an aspect ratio of 1.73 against the page's true
    /// 1.414 — a 22% error that the old per-page estimate handed straight
    /// to the canvas. Page 21 reaches furthest right (x=2273) and page 88
    /// furthest down (y=1645); no page reaches both, which is exactly why
    /// the two sides are pooled across the document.
    fn real_landscape_extents() -> Vec<(f64, f64)> {
        vec![
            (2145.0, 1559.0),
            (2167.0, 1252.0),
            (2273.0, 1550.0),
            (2195.0, 1645.0),
        ]
    }

    #[test]
    fn infers_one_document_wide_size_for_every_unmeasured_page() {
        let root = serde_json::Value::Array(
            real_landscape_extents()
                .into_iter()
                .map(|(x, y)| extent_page(x, y))
                .collect(),
        );
        let import = analyze_value(root).unwrap();

        let first = &import.document.pages[0];
        for page in &import.document.pages {
            assert!(
                page.dimensions_approximate,
                "page {} has no measured size and must say so",
                page.index
            );
            assert_eq!(
                (page.width, page.height),
                (first.width, first.height),
                "page {} must share the document-level size, not its own extent",
                page.index
            );
        }
        assert_eq!(import.preflight.estimated_dimension_pages, vec![1, 2, 3, 4]);
    }

    #[test]
    fn both_inferred_sides_are_close_lower_bounds_on_the_real_render() {
        let root = serde_json::Value::Array(
            real_landscape_extents()
                .into_iter()
                .map(|(x, y)| extent_page(x, y))
                .collect(),
        );
        let import = analyze_value(root).unwrap();

        for page in &import.document.pages {
            let long = page.width.max(page.height);
            let short = page.width.min(page.height);
            // Lower bounds by construction — content stops short of the
            // paper's edge — give or take the one padding step.
            let slack = 1.0 + EXTENT_PADDING;
            assert!(
                long <= REAL_RENDER.0 * slack && short <= REAL_RENDER.1 * slack,
                "page {}: {long}x{short} is not a bound on {REAL_RENDER:?}",
                page.index
            );
            // Close ones: the canvas turns the pair into a scale factor and
            // needs the tighter of the two to be near the mark.
            assert!(
                (long / REAL_RENDER.0 - 1.0).abs() < 0.05,
                "page {}: long side {long} vs real {}",
                page.index,
                REAL_RENDER.0
            );
            assert!(
                (short / REAL_RENDER.1 - 1.0).abs() < 0.02,
                "page {}: short side {short} vs real {}",
                page.index,
                REAL_RENDER.1
            );
        }
    }

    #[test]
    fn a_page_whose_content_stops_early_is_no_longer_sized_by_its_own_extent() {
        // Page 15 alone. On its own it is all the evidence there is, so the
        // inference can only reproduce its extent — the regression guard is
        // that adding the rest of the document fixes it, which is exactly
        // what the per-page estimate could never do.
        let solo = analyze_value(json!([extent_page(2167.0, 1252.0)])).unwrap();
        let solo_aspect = solo.document.pages[0].width / solo.document.pages[0].height;
        assert!(
            (solo_aspect - 1.414).abs() > 0.2,
            "single-page inference cannot know better: {solo_aspect}"
        );

        let root = serde_json::Value::Array(
            real_landscape_extents()
                .into_iter()
                .map(|(x, y)| extent_page(x, y))
                .collect(),
        );
        let full = analyze_value(root).unwrap();
        let page15 = &full.document.pages[2];
        let aspect = page15.width / page15.height;
        assert!(
            (aspect / (REAL_RENDER.0 / REAL_RENDER.1) - 1.0).abs() < 0.05,
            "in document context page 15's aspect must come back to the page's: {aspect}"
        );
    }

    #[test]
    fn mixed_orientations_pool_their_evidence_into_one_transposed_pair() {
        // Page 25 of the same export is portrait (the PDF has 81 landscape
        // pages and 7 portrait ones).
        let mut pages: Vec<serde_json::Value> = real_landscape_extents()
            .into_iter()
            .map(|(x, y)| extent_page(x, y))
            .collect();
        pages.push(extent_page(1530.0, 2125.0));
        let import = analyze_value(serde_json::Value::Array(pages)).unwrap();

        let landscape = &import.document.pages[0];
        let portrait = &import.document.pages[4];
        assert!(landscape.width > landscape.height);
        assert!(portrait.height > portrait.width);
        // One render scale, so the two orientations are the same pair
        // transposed — the portrait pages' own extents (1530×2125) are
        // nowhere near the paper and would be a much worse estimate on their
        // own than the landscape pages' evidence makes them.
        assert_eq!(landscape.width, portrait.height);
        assert_eq!(landscape.height, portrait.width);
        assert!(
            (portrait.height / REAL_RENDER.0 - 1.0).abs() < 0.05,
            "portrait long side {} vs real {}",
            portrait.height,
            REAL_RENDER.0
        );
    }

    #[test]
    fn a_measured_page_pins_the_size_for_the_unmeasured_ones() {
        // Mixed evidence: one page carries `page_size`, the rest carry
        // nothing. A measurement outranks any extent — and is not padded.
        let mut pages = vec![json!({
            "prunedResult": {
                "page_size": [2382, 1684],
                "parsing_res_list": [
                    { "block_label": "text", "block_content": "x", "block_bbox": [0, 0, 2145, 1559] }
                ]
            }
        })];
        pages.push(extent_page(2145.0, 1559.0));
        let import = analyze_value(serde_json::Value::Array(pages)).unwrap();

        assert!(!import.document.pages[0].dimensions_approximate);
        assert_eq!(import.document.pages[0].width, 2382.0);
        let inferred = &import.document.pages[1];
        assert!(inferred.dimensions_approximate);
        assert_eq!(
            (inferred.width, inferred.height),
            (2382.0, 1684.0),
            "the measured page states the render scale; the inferred page must adopt it"
        );
        assert_eq!(import.preflight.estimated_dimension_pages, vec![2]);
    }

    #[test]
    fn measured_pages_are_never_flagged_approximate() {
        let root = json!([{
            "prunedResult": { "page_size": [800, 1000], "parsing_res_list": [
                { "block_label": "text", "block_content": "x", "block_bbox": [0, 0, 10, 10] }
            ]}
        }]);
        let import = analyze_value(root).unwrap();
        assert!(!import.document.pages[0].dimensions_approximate);
        assert_eq!(import.document.pages[0].width, 800.0);
        assert_eq!(import.document.pages[0].height, 1000.0);
        assert!(import.preflight.estimated_dimension_pages.is_empty());
    }

    #[test]
    fn a_page_without_blocks_still_gets_the_document_size() {
        let mut pages = vec![json!({ "prunedResult": { "parsing_res_list": [] } })];
        pages.push(extent_page(2145.0, 1559.0));
        let import = analyze_value(serde_json::Value::Array(pages)).unwrap();
        assert!(import.document.pages[0].width > 0.0);
        assert!(import.document.pages[0].height > 0.0);
    }

    /// End-to-end check against a real Paddle web-export JSON on disk. No
    /// network — the whole point of the change is that none is needed. Run:
    /// `CARPO_SAMPLE_JSON=/path/file.json cargo test --manifest-path carpo-core/Cargo.toml
    ///  real_json_dimensions_are_isotropic -- --ignored --nocapture`
    ///
    /// Set `CARPO_SAMPLE_RENDER_LONG` *and* `CARPO_SAMPLE_RENDER_SHORT` to the
    /// true size of the producer's render (for a PDF put through
    /// PaddleOCR-VL: the page's edges in points × 2) to also assert the scale
    /// factor the canvas would derive.
    #[test]
    #[ignore]
    fn real_json_dimensions_are_isotropic() {
        let json_path = std::env::var("CARPO_SAMPLE_JSON").expect("set CARPO_SAMPLE_JSON");
        let import = analyze_path(std::path::Path::new(&json_path)).expect("analyze json");
        println!(
            "{} pages, {} inferred",
            import.preflight.page_count,
            import.preflight.estimated_dimension_pages.len()
        );
        let sizes: std::collections::BTreeSet<String> = import
            .document
            .pages
            .iter()
            .filter(|p| p.dimensions_approximate)
            .map(|p| format!("{:.1}x{:.1}", p.width.max(p.height), p.width.min(p.height)))
            .collect();
        println!("distinct inferred sizes (long x short): {sizes:?}");
        assert!(
            sizes.len() <= 1,
            "every inferred page must share one size, got {sizes:?}"
        );
        for page in &import.document.pages {
            assert!(
                page.width > 0.0 && page.height > 0.0,
                "page {} has a zero side",
                page.index
            );
        }

        if let Ok(real_long) = std::env::var("CARPO_SAMPLE_RENDER_LONG") {
            let real_long: f64 = real_long.parse().expect("a number");
            let real_short: f64 = std::env::var("CARPO_SAMPLE_RENDER_SHORT")
                .expect("set CARPO_SAMPLE_RENDER_SHORT too")
                .parse()
                .expect("a number");
            let page = import
                .document
                .pages
                .iter()
                .find(|p| p.dimensions_approximate)
                .expect("nothing was inferred — nothing to check");
            let long = page.width.max(page.height);
            let short = page.width.min(page.height);
            // The page bitmap the canvas draws. Its own resolution cancels
            // out of the ratios, so the render's own size stands in for it —
            // what matters is that it carries the *page's* aspect ratio and
            // not the inferred one, which is the whole source of the second,
            // independent bound.
            let (image_long, image_short) = (real_long, real_short);
            // What `layoutCanvasMapping` does for an approximate page: both
            // sides are lower bounds, so both ratios bound the scale from
            // above and the smaller is the estimate.
            let scale = (image_long / long).min(image_short / short);
            let error = (scale - 1.0).abs();
            println!(
                "inferred {long:.1}x{short:.1} vs real long {real_long}: \
                 canvas scale error {:.2}%",
                error * 100.0
            );
            assert!(
                error < 0.01,
                "the derived scale is {:.2}% off; a highlight would visibly miss",
                error * 100.0
            );
        }
        for w in &import.preflight.warnings {
            println!("warn: {w}");
        }
    }
}
