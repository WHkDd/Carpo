//! One adaptive PDF: retain readable block positions; reflow dense/edited pages.
//! Articles flow independently. Optional source comparisons share the same PDF
//! context and font mapping, including mixed whole-page/article batches.

use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs, mem,
    path::PathBuf,
};

use printpdf::{
    Color, DictItem, ExternalStream, ExternalXObject, FontId, FontMetrics, Mm, Op, ParsedFont,
    PdfDocument, PdfFontHandle, PdfPage, PdfSaveOptions, Point, Pt, Px, Rect, Rgb, TextItem,
    XObjectId, XObjectTransform,
};
use serde::{Deserialize, Serialize};
use ttf_parser::Face;

use carpo_core::{
    error::{AppError, AppResult},
    ocr::paddle_json::{LayoutBlock, LayoutDocument, LayoutPage},
};

const A4_W_PT: f32 = 595.28;
const A4_H_PT: f32 = 841.89;
const MARGIN_X_PT: f32 = 56.0;
const MARGIN_TOP_PT: f32 = 60.0;
const MARGIN_BOTTOM_PT: f32 = 56.0;
const MAX_RETURNED_WARNINGS: usize = 50;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutPdfExportRequest {
    pub document: LayoutDocument,
    pub target_path: String,
    #[serde(default)]
    pub options: LayoutPdfExportOptions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutPdfExportResult {
    pub target_path: String,
    /// Number of output pages in the PDF (reading flow, not source pages).
    pub page_count: u32,
    pub warning_count: u32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingMarkdownExportResult {
    pub target_path: String,
    /// Number of source pages folded into the Markdown file.
    pub page_count: u32,
    pub warning_count: u32,
    pub warnings: Vec<String>,
}

/// Retained for wire compatibility. Both values use adaptive PDF layout.
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LayoutPdfExportMode {
    Bbox,
    #[default]
    Reading,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutPdfExportOptions {
    #[serde(default)]
    pub mode: LayoutPdfExportMode,
    #[serde(default)]
    pub include_header: bool,
    #[serde(default)]
    pub include_footer: bool,
    #[serde(default = "default_true")]
    pub include_page_number: bool,
    #[serde(default)]
    pub include_aside_text: bool,
    #[serde(default = "default_true")]
    pub include_footnote: bool,
    #[serde(default)]
    pub include_images: bool,
    #[serde(default = "default_true")]
    pub include_tables: bool,
    #[serde(default = "default_scale")]
    pub font_scale: f32,
    #[serde(default = "default_scale")]
    pub margin_scale: f32,
    #[serde(default)]
    pub with_source: bool,
    #[serde(default)]
    pub parts: Vec<PdfExportPart>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportImage {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfArticle {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub images: Vec<ExportImage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExportPart {
    pub name: String,
    pub document: LayoutDocument,
    #[serde(default)]
    pub source_images: BTreeMap<u32, ExportImage>,
    #[serde(default)]
    pub articles: Vec<PdfArticle>,
}

impl Default for LayoutPdfExportOptions {
    fn default() -> Self {
        Self {
            mode: LayoutPdfExportMode::Reading,
            include_header: false,
            include_footer: false,
            include_page_number: true,
            include_aside_text: false,
            include_footnote: true,
            include_images: false,
            include_tables: true,
            font_scale: 1.0,
            margin_scale: 1.0,
            with_source: false,
            parts: Vec::new(),
        }
    }
}

const fn default_true() -> bool {
    true
}

const fn default_scale() -> f32 {
    1.0
}

// ---------------------------------------------------------------------------
// Block roles
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockRole {
    DocTitle,
    Heading,
    FigureCaption,
    Body,
    Footnote,
    Table,
    Image,
    Header,
    Footer,
    PageNumber,
    Aside,
}

fn classify(label: &str) -> BlockRole {
    let label = label.trim().to_ascii_lowercase();
    match label.as_str() {
        "doc_title" => BlockRole::DocTitle,
        "paragraph_title" | "title" => BlockRole::Heading,
        "figure_title" | "chart_title" | "table_title" => BlockRole::FigureCaption,
        "header" | "doc_header" | "header_image" => BlockRole::Header,
        "footer" | "doc_footer" | "footer_image" => BlockRole::Footer,
        "number" | "page_number" | "page_no" | "page_num" => BlockRole::PageNumber,
        "aside_text" | "aside" => BlockRole::Aside,
        _ => {
            if label.contains("footnote") {
                BlockRole::Footnote
            } else if label.contains("table") {
                BlockRole::Table
            } else if label.contains("image") || label == "figure" {
                BlockRole::Image
            } else {
                // text, content, vertical_text, display_formula, algorithm, …
                BlockRole::Body
            }
        }
    }
}

/// Whether a block participates in the reading flow. Page numbers never do
/// (they become the page anchor instead).
fn include_in_reading(role: BlockRole, options: &LayoutPdfExportOptions) -> bool {
    match role {
        BlockRole::Header => options.include_header,
        BlockRole::Footer => options.include_footer,
        BlockRole::Aside => options.include_aside_text,
        BlockRole::Footnote => options.include_footnote,
        BlockRole::Table => options.include_tables,
        BlockRole::PageNumber => false,
        // Images always show a placeholder so the reader knows one was there.
        BlockRole::Image
        | BlockRole::DocTitle
        | BlockRole::Heading
        | BlockRole::FigureCaption
        | BlockRole::Body => true,
    }
}

/// Blocks sorted into reading order for a page. `block_order` is authoritative
/// when present; otherwise fall back to top-to-bottom, then right-to-left so
/// vertical books (columns read right first) come out roughly right.
fn ordered_blocks(page: &LayoutPage) -> Vec<&LayoutBlock> {
    let mut blocks: Vec<&LayoutBlock> = page.blocks.iter().collect();
    let any_order = blocks.iter().any(|b| b.order.is_some());
    if any_order {
        blocks.sort_by(|a, b| {
            a.order
                .unwrap_or(u32::MAX)
                .cmp(&b.order.unwrap_or(u32::MAX))
        });
    } else {
        blocks.sort_by(|a, b| {
            a.bbox[1]
                .total_cmp(&b.bbox[1])
                .then_with(|| b.bbox[0].total_cmp(&a.bbox[0]))
        });
    }
    blocks
}

/// The page anchor text uses the sequential source page index, not OCR's
/// printed-page guess. Real exports showed `number` blocks picking up table of
/// contents entries and cover noise, which made anchors jump or repeat. Source
/// page indices are less pretty but reliable for citation back to the PDF.
fn page_anchor_label(page: &LayoutPage) -> String {
    carpo_core::trf!("源文件第 {} 页", "Source page {}", page.index)
}

/// Strip leading Markdown heading/quote markers (`#`, `>`) and a single layer of
/// surrounding bold/italic/code emphasis (`***`, `**`, `*`, `` ` ``) so headings
/// can be re-styled from the label and body text never shows a stray `####`.
fn clean_block_text(text: &str) -> String {
    let mut out_lines = Vec::new();
    for raw in text.replace("\r\n", "\n").split('\n') {
        let mut line = raw.trim_end();
        // Leading heading / quote markers.
        line = line.trim_start();
        let mut chars = line.char_indices().peekable();
        let mut strip_to = 0usize;
        while let Some(&(idx, c)) = chars.peek() {
            if c == '#' || c == '>' {
                strip_to = idx + c.len_utf8();
                chars.next();
            } else if c == ' ' && strip_to > 0 {
                strip_to = idx + 1;
                chars.next();
            } else {
                break;
            }
        }
        let mut s = line[strip_to..].to_string();
        // Symmetric emphasis wrappers.
        for marker in ["***", "**", "*", "`"] {
            if s.len() >= marker.len() * 2 && s.starts_with(marker) && s.ends_with(marker) {
                s = s[marker.len()..s.len() - marker.len()].to_string();
                break;
            }
        }
        out_lines.push(s);
    }
    out_lines.join("\n").trim().to_string()
}

/// Remove HTML tags (and collapse whitespace) — used to salvage any caption
/// text from an image block's `<div><img .../></div>` wrapper.
fn strip_html(text: &str) -> String {
    let mut out = String::new();
    let mut depth = 0u32;
    for c in text.chars() {
        match c {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------
// Reading items (shared intermediate for PDF + Markdown)
// ---------------------------------------------------------------------------

struct ReadingItem {
    role: BlockRole,
    /// `None` marks a page anchor; `Some(text)` is a renderable block.
    text: Option<String>,
    /// For anchors, the page label.
    anchor: Option<String>,
}

fn build_reading_items(
    document: &LayoutDocument,
    options: &LayoutPdfExportOptions,
    warnings: &mut Vec<String>,
) -> Vec<ReadingItem> {
    let mut items = Vec::new();
    let inferred_furniture = infer_repeated_furniture_texts(document);
    let mut image_notice = false;
    let mut empty_table_notice = false;
    let mut inferred_furniture_count = 0usize;
    let mut scanner_artifact_count = 0usize;
    let mut content_free_pages = 0usize;
    for page in &document.pages {
        let mut page_items = Vec::new();
        for block in ordered_blocks(page) {
            let role = classify(&block.label);
            if !include_in_reading(role, options) {
                continue;
            }
            if should_skip_inferred_furniture(page, block, &inferred_furniture, options) {
                inferred_furniture_count += 1;
                continue;
            }
            let mut cleaned = clean_block_text(&block.text);
            if is_known_scanner_artifact(&cleaned) {
                scanner_artifact_count += 1;
                continue;
            }
            if should_strip_html_for_role(role) {
                cleaned = clean_block_text(&strip_html(&cleaned));
            }
            if should_repair_short_lines(role) {
                cleaned = repair_short_vertical_lines(&cleaned);
            }
            let text = match role {
                BlockRole::Image => {
                    image_notice = true;
                    // Image blocks usually carry an HTML `<div><img .../></div>`
                    // wrapper, not reading text. Strip tags; keep only a caption
                    // if one survives.
                    let placeholder = image_placeholder(block.image_ref.as_deref());
                    if cleaned.is_empty() {
                        placeholder
                    } else {
                        format!("{placeholder} {cleaned}")
                    }
                }
                BlockRole::Table => {
                    if cleaned.is_empty() {
                        empty_table_notice = true;
                        carpo_core::tr!("［表格］", "[table]").to_string()
                    } else {
                        cleaned
                    }
                }
                _ => {
                    if cleaned.is_empty() {
                        continue;
                    }
                    cleaned
                }
            };
            page_items.push(ReadingItem {
                role,
                text: Some(text),
                anchor: None,
            });
        }
        // The page-number anchor's output depends only on
        // `include_page_number`, never on whether the page produced content:
        // a source page whose text was emptied (or whose blocks were all
        // filtered out) must still be visible in the reading edition as its
        // page-number line — otherwise the page vanishes silently and
        // page-by-page collation against the source breaks. With
        // `include_page_number` off the user opted out of anchors entirely,
        // and a content-free page produces nothing.
        if options.include_page_number {
            items.push(ReadingItem {
                role: BlockRole::PageNumber,
                text: None,
                anchor: Some(page_anchor_label(page)),
            });
        }
        if page_items.is_empty() {
            content_free_pages += 1;
        } else {
            items.extend(page_items);
        }
    }
    if image_notice {
        if options.include_images {
            warnings.push(
                        carpo_core::tr!(
                    "图片内嵌尚未实现，图片区块已用占位说明表示",
                    "Embedding images is not implemented yet — image blocks are shown as placeholders"
                )
                .to_string(),
            );
        } else {
            warnings.push(
                carpo_core::tr!(
                    "图片区块未嵌入，已用占位说明表示",
                    "Image blocks were not embedded — they are shown as placeholders"
                )
                .to_string(),
            );
        }
    }
    if empty_table_notice {
        warnings.push(
            carpo_core::tr!(
                "部分表格无文本内容，已用占位说明表示",
                "Some tables carry no text — they are shown as placeholders"
            )
            .to_string(),
        );
    }
    if inferred_furniture_count > 0 {
        warnings.push(carpo_core::trf!(
            "已过滤 {} 个重复页眉/页脚块",
            "Filtered out {} repeated header/footer blocks",
            inferred_furniture_count
        ));
    }
    if scanner_artifact_count > 0 {
        warnings.push(carpo_core::trf!(
            "已过滤 {} 个扫描/封装元数据块",
            "Filtered out {} scanner / container metadata blocks",
            scanner_artifact_count
        ));
    }
    if content_free_pages > 0 {
        warnings.push(carpo_core::trf!(
            "{} 个源页无可导出内容，已仅保留页码",
            "{} source page(s) carried no exportable content — page numbers kept",
            content_free_pages
        ));
    }
    items
}

fn image_placeholder(image_ref: Option<&str>) -> String {
    match image_ref.and_then(display_image_ref) {
        Some(source) => {
            carpo_core::trf!("［图片：未嵌入：{}］", "[image: not embedded: {}]", source)
        }
        None => carpo_core::tr!("［图片：未嵌入］", "[image: not embedded]").to_string(),
    }
}

fn display_image_ref(image_ref: &str) -> Option<String> {
    let trimmed = image_ref.trim();
    if trimmed.is_empty() {
        return None;
    }
    let display = if trimmed.contains("://") {
        trimmed
            .split('?')
            .next()
            .unwrap_or(trimmed)
            .rsplit('/')
            .find(|part| !part.is_empty())
            .unwrap_or(trimmed)
    } else {
        trimmed
    };
    if display.chars().count() > 80 {
        Some(format!("{}…", display.chars().take(79).collect::<String>()))
    } else {
        Some(display.to_string())
    }
}

fn is_known_scanner_artifact(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with("Document generated by Anna's Archive around")
        || trimmed.starts_with("Images have been losslessly embedded.")
}

fn infer_repeated_furniture_texts(document: &LayoutDocument) -> BTreeSet<String> {
    let mut by_text: BTreeMap<String, BTreeSet<u32>> = BTreeMap::new();
    for page in &document.pages {
        for block in &page.blocks {
            if classify(&block.label) != BlockRole::Body {
                continue;
            }
            if inferred_furniture_kind(page, block).is_none() {
                continue;
            }
            if let Some(key) = furniture_text_key(&block.text) {
                by_text.entry(key).or_default().insert(page.index);
            }
        }
    }
    by_text
        .into_iter()
        .filter_map(|(text, pages)| (pages.len() >= 3).then_some(text))
        .collect()
}

fn should_skip_inferred_furniture(
    page: &LayoutPage,
    block: &LayoutBlock,
    repeated_texts: &BTreeSet<String>,
    options: &LayoutPdfExportOptions,
) -> bool {
    if classify(&block.label) != BlockRole::Body {
        return false;
    }
    let Some(key) = furniture_text_key(&block.text) else {
        return false;
    };
    if !repeated_texts.contains(&key) {
        return false;
    }
    match inferred_furniture_kind(page, block) {
        Some(BlockRole::Header) => !options.include_header,
        Some(BlockRole::Footer) => !options.include_footer,
        _ => false,
    }
}

fn furniture_text_key(text: &str) -> Option<String> {
    let cleaned = repair_short_vertical_lines(&clean_block_text(&strip_html(text)));
    let key = cleaned
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    let len = key.chars().count();
    (3..=40).contains(&len).then_some(key)
}

fn inferred_furniture_kind(page: &LayoutPage, block: &LayoutBlock) -> Option<BlockRole> {
    let page_w = page.width.max(1.0);
    let page_h = page.height.max(1.0);
    let (x1, y1, x2, y2, w, h) = bbox_parts(block.bbox);
    let near_top = y1 <= page_h * 0.12 && h <= page_h * 0.10;
    let near_bottom = y2 >= page_h * 0.88 && h <= page_h * 0.10;
    let near_side =
        (x1 <= page_w * 0.13 || x2 >= page_w * 0.87) && w <= page_w * 0.12 && h <= page_h * 0.50;
    if near_bottom {
        Some(BlockRole::Footer)
    } else if near_top || near_side {
        Some(BlockRole::Header)
    } else {
        None
    }
}

fn bbox_parts(bbox: [f64; 4]) -> (f64, f64, f64, f64, f64, f64) {
    let x1 = bbox[0].min(bbox[2]);
    let y1 = bbox[1].min(bbox[3]);
    let x2 = bbox[0].max(bbox[2]);
    let y2 = bbox[1].max(bbox[3]);
    (x1, y1, x2, y2, x2 - x1, y2 - y1)
}

fn should_strip_html_for_role(role: BlockRole) -> bool {
    matches!(
        role,
        BlockRole::DocTitle | BlockRole::Heading | BlockRole::FigureCaption | BlockRole::Image
    )
}

/// Only title-like blocks get their per-column line fragments joined back into
/// one phrase. Body blocks are excluded on purpose: a genuine body block whose
/// lines all happen to be short (a vertical directory column, a couplet, a short
/// list) would otherwise be collapsed into one run-on line with its entries
/// silently merged.
fn should_repair_short_lines(role: BlockRole) -> bool {
    matches!(
        role,
        BlockRole::DocTitle | BlockRole::Heading | BlockRole::FigureCaption
    )
}

/// Paddle keeps some vertical title / directory fragments as one short line
/// per printed column segment, e.g. `新聞\n\n之\n\n採\n\n集`. When every
/// non-empty line is very short, join them back into one reading phrase.
fn repair_short_vertical_lines(text: &str) -> String {
    let lines = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if lines.len() < 2 {
        return text.to_string();
    }
    if lines.iter().all(|line| line.chars().count() <= 4) {
        return lines.join("");
    }
    text.to_string()
}

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------

pub fn export_layout_pdf_to_path(req: LayoutPdfExportRequest) -> AppResult<LayoutPdfExportResult> {
    let options = &req.options;
    let fallback;
    let parts = if options.parts.is_empty() {
        fallback = vec![PdfExportPart {
            name: String::new(),
            document: req.document.clone(),
            source_images: BTreeMap::new(),
            articles: Vec::new(),
        }];
        &fallback
    } else {
        &options.parts
    };
    let all_pages = LayoutDocument {
        source: "paddle".into(),
        pages: parts
            .iter()
            .flat_map(|p| p.document.pages.clone())
            .collect(),
    };
    // Article-only PDFs have no page layout to validate.
    let target_path = if all_pages.pages.is_empty() && parts.iter().any(|p| !p.articles.is_empty())
    {
        if req.target_path.trim().is_empty() {
            return Err(AppError::Config("缺少导出路径 / No export path".into()));
        }
        PathBuf::from(&req.target_path)
    } else {
        validate_target(&req.target_path, &all_pages)?
    };
    let mut warnings = Vec::new();
    let mut chars = BTreeSet::new();
    // Include original block text as well as flattened table text: cell layout
    // and source labels must use exactly the same Unicode mapping as the body.
    chars.extend("第页续未命名文件图片原图缺失正文0123456789 ·：〔〕（）".chars());
    for part in parts {
        chars.extend(part.name.chars());
        for page in &part.document.pages {
            for block in &page.blocks {
                chars.extend(clean_block_text(&strip_html(&block.text)).chars());
            }
        }
        for article in &part.articles {
            chars.extend(article.title.chars());
            chars.extend(clean_block_text(&strip_html(&article.body)).chars());
        }
        chars.extend(collect_item_chars(&build_reading_items(
            &part.document,
            options,
            &mut Vec::new(),
        )));
    }
    chars.retain(|ch| !ch.is_control());
    let loaded_font = load_cjk_font(&chars)?;
    push_missing_char_warning(&loaded_font, &mut warnings);
    let mut doc = PdfDocument::new("Carpo reading export");
    let font_id = doc.add_font(&loaded_font.font);
    let mut pages = Vec::new();
    for part in parts {
        render_pdf_part(
            &mut doc,
            &font_id,
            &loaded_font.font,
            part,
            options,
            &mut pages,
            &mut warnings,
        )?;
    }
    if pages.is_empty() {
        return Err(AppError::Config(
            "没有可导出的 PDF 内容 / No PDF content".into(),
        ));
    }
    let page_count = pages.len() as u32;
    doc.with_pages(pages);

    let mut pdf_warnings = Vec::new();
    let pdf_bytes = doc.save(&PdfSaveOptions::default(), &mut pdf_warnings);
    for warning in pdf_warnings {
        warnings.push(format!("{warning:?}"));
    }
    fs::write(&target_path, pdf_bytes)
        .map_err(|e| AppError::Internal(format!("write {}: {e}", target_path.display())))?;

    let warning_count = warnings.len() as u32;
    Ok(LayoutPdfExportResult {
        target_path: target_path.display().to_string(),
        page_count,
        warning_count,
        warnings: warnings.into_iter().take(MAX_RETURNED_WARNINGS).collect(),
    })
}

// A source page uses one physical-page-sized canvas; 8pt is the readable floor.
const MIN_LAYOUT_FONT: f32 = 8.0;

fn measured_width(font: &ParsedFont, text: &str, size: f32) -> f32 {
    text.chars()
        .map(|ch| {
            font.lookup_glyph_index(ch as u32)
                .and_then(|id| font.get_glyph_width(id))
                .map(|width| width as f32 / font.units_per_em.max(1) as f32)
                .unwrap_or_else(|| estimated_char_width(ch))
                * size
        })
        .sum()
}

fn wrap_measured(font: &ParsedFont, text: &str, width: f32, size: f32) -> Vec<String> {
    let mut lines = Vec::new();
    for source in text.lines() {
        if source.trim().is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut line = String::new();
        let mut used = 0.0;
        for ch in source.chars() {
            let advance = measured_width(font, &ch.to_string(), size);
            if !line.is_empty() && used + advance > width {
                let word_break = if ch.is_ascii_alphanumeric() {
                    line.rfind(' ').filter(|at| *at > 0)
                } else {
                    None
                };
                // Avoid a closing punctuation mark at the beginning of a line.
                if let Some(at) = word_break {
                    let tail = line.split_off(at + 1);
                    line.pop();
                    lines.push(mem::take(&mut line));
                    line = tail;
                    used = measured_width(font, &line, size);
                } else if "，。；：！？、）》」』】,.!?;:".contains(ch) {
                    if let Some(last) = line.pop() {
                        lines.push(mem::take(&mut line));
                        line.push(last);
                        used = measured_width(font, &line, size);
                    }
                } else {
                    lines.push(mem::take(&mut line));
                    used = 0.0;
                }
            }
            line.push(ch);
            used += advance;
        }
        if !line.is_empty() {
            lines.push(line);
        }
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn table_rows(text: &str) -> Vec<Vec<String>> {
    if !looks_like_html_table(text) {
        return text
            .lines()
            .filter(|line| line.contains('|'))
            .filter(|line| !line.chars().all(|c| "|-: \t".contains(c)))
            .map(|line| {
                line.trim()
                    .trim_matches('|')
                    .split('|')
                    .map(|cell| cell.trim().to_string())
                    .collect()
            })
            .collect();
    }
    // Parse cells without discarding empty columns. Spans reserve grid positions,
    // so following rows retain their column alignment even when reflowed.
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row = Vec::new();
    let mut cell = String::new();
    let mut in_cell = false;
    let mut colspan = 1;
    let mut rowspan = 1;
    let mut occupied: Vec<usize> = Vec::new();
    let mut col = 0;
    let mut rest = text;
    while let Some(start) = rest.find('<') {
        if in_cell {
            cell.push_str(&rest[..start]);
        }
        rest = &rest[start + 1..];
        let Some(end) = rest.find('>') else {
            break;
        };
        let raw = &rest[..end];
        let tag = raw.trim().to_ascii_lowercase();
        rest = &rest[end + 1..];
        if tag.starts_with("td") || tag.starts_with("th") && !tag.starts_with("thead") {
            while occupied.get(col).copied().unwrap_or(0) > rows.len() {
                row.push(String::new());
                col += 1;
            }
            in_cell = true;
            cell.clear();
            colspan = html_span(&tag, "colspan");
            rowspan = html_span(&tag, "rowspan");
        } else if tag == "/td" || tag == "/th" {
            if in_cell {
                row.push(decode_basic_html_entities(cell.trim()));
                for _ in 1..colspan {
                    row.push(String::new());
                }
                occupied.resize(occupied.len().max(col + colspan), 0);
                for slot in &mut occupied[col..col + colspan] {
                    *slot = rows.len() + rowspan;
                }
                col += colspan;
                in_cell = false;
            }
        } else if tag == "/tr" {
            if !row.is_empty() {
                rows.push(mem::take(&mut row));
            }
            col = 0;
        } else if in_cell && (tag == "br" || tag == "br/" || tag == "/p") {
            cell.push('\n');
        }
    }
    if !row.is_empty() {
        rows.push(row);
    }
    rows
}

fn html_span(tag: &str, attribute: &str) -> usize {
    tag.find(attribute)
        .and_then(|at| {
            let value = tag[at + attribute.len()..]
                .trim_start()
                .strip_prefix('=')?
                .trim_start()
                .trim_start_matches(['\'', '"']);
            let number: String = value.chars().take_while(char::is_ascii_digit).collect();
            number.parse::<usize>().ok()
        })
        .unwrap_or(1)
        .clamp(1, 100)
}

fn table_height(font: &ParsedFont, rows: &[Vec<String>], width: f32, size: f32) -> f32 {
    let cols = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
    rows.iter()
        .map(|row| {
            row.iter()
                .map(|cell| {
                    wrap_measured(font, cell, (width / cols as f32 - 8.0).max(size), size).len()
                })
                .max()
                .unwrap_or(1) as f32
                * size
                * 1.35
                + 8.0
        })
        .sum()
}

fn draw_cell(ops: &mut Vec<Op>, font_id: &FontId, lines: &[String], rect: &Rect, size: f32) {
    let top = rect.y.0 + rect.height.0;
    ops.push(Op::SetOutlineColor {
        col: Color::Rgb(Rgb::new(0.65, 0.65, 0.65, None)),
    });
    ops.push(Op::SetOutlineThickness { pt: Pt(0.4) });
    ops.push(Op::DrawLine {
        line: rect.to_line(),
    });
    for (i, line) in lines.iter().enumerate() {
        draw_line(
            ops,
            font_id,
            line,
            rect.x.0 + 4.0,
            top - 4.0 - size - i as f32 * size * 1.35,
            size,
            Color::Rgb(Rgb::new(0.1, 0.1, 0.1, None)),
        );
    }
}

fn draw_table(
    ops: &mut Vec<Op>,
    font_id: &FontId,
    font: &ParsedFont,
    rows: &[Vec<String>],
    rect: &Rect,
    size: f32,
) {
    let cols = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
    let width = rect.width.0 / cols as f32;
    let mut top = rect.y.0 + rect.height.0;
    for row in rows {
        let cells: Vec<_> = (0..cols)
            .map(|i| {
                wrap_measured(
                    font,
                    row.get(i).map(String::as_str).unwrap_or(""),
                    (width - 8.0).max(size),
                    size,
                )
            })
            .collect();
        let height = cells.iter().map(Vec::len).max().unwrap_or(1) as f32 * size * 1.35 + 8.0;
        for (i, lines) in cells.iter().enumerate() {
            draw_cell(
                ops,
                font_id,
                lines,
                &Rect::from_xywh(
                    Pt(rect.x.0 + i as f32 * width),
                    Pt(top - height),
                    Pt(width),
                    Pt(height),
                ),
                size,
            );
        }
        top -= height;
    }
}

fn decode_source(source: &ExportImage) -> AppResult<image::RgbImage> {
    if source.width == 0 || source.height == 0 || source.jpeg.is_empty() {
        return Err(AppError::Config("原图无效 / Invalid source image".into()));
    }
    let decoded = image::load_from_memory(&source.jpeg)
        .map_err(|error| AppError::Internal(format!("decode source image: {error}")))?
        .to_rgb8();
    Ok(decoded)
}

fn add_image(doc: &mut PdfDocument, image: image::RgbImage) -> AppResult<(XObjectId, u32, u32)> {
    let (width, height) = image.dimensions();
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85)
        .encode_image(&image)
        .map_err(|error| AppError::Internal(format!("encode PDF image: {error}")))?;
    // JPEG streams embed directly, avoiding both lossless RGB bloat and the
    // optional image conversion feature in printpdf.
    let id = doc.add_xobject(&ExternalXObject {
        stream: ExternalStream {
            content: jpeg,
            compress: false,
            dict: BTreeMap::from([
                ("Type".into(), DictItem::Name(b"XObject".to_vec())),
                ("Subtype".into(), DictItem::Name(b"Image".to_vec())),
                ("Filter".into(), DictItem::Name(b"DCTDecode".to_vec())),
                ("Width".into(), DictItem::Int(width as i64)),
                ("Height".into(), DictItem::Int(height as i64)),
                ("BitsPerComponent".into(), DictItem::Int(8)),
                ("ColorSpace".into(), DictItem::Name(b"DeviceRGB".to_vec())),
            ]),
        },
        width: Some(Px(width as usize)),
        height: Some(Px(height as usize)),
        dpi: Some(72.0),
    });
    Ok((id, width, height))
}

fn place_image(ops: &mut Vec<Op>, id: &XObjectId, native: (u32, u32), rect: &Rect) {
    let scale = (rect.width.0 / native.0.max(1) as f32).min(rect.height.0 / native.1.max(1) as f32);
    let width = native.0 as f32 * scale;
    let height = native.1 as f32 * scale;
    ops.push(Op::UseXobject {
        id: id.clone(),
        transform: XObjectTransform {
            translate_x: Some(Pt(rect.x.0 + (rect.width.0 - width) / 2.0)),
            translate_y: Some(Pt(rect.y.0 + rect.height.0 - height)),
            scale_x: Some(scale),
            scale_y: Some(scale),
            dpi: Some(72.0),
            ..Default::default()
        },
    });
}

fn block_rect(page: &LayoutPage, block: &LayoutBlock, size: (f32, f32)) -> Option<Rect> {
    if !page.width.is_finite()
        || !page.height.is_finite()
        || page.width <= 0.0
        || page.height <= 0.0
        || block.bbox.iter().any(|n| !n.is_finite())
    {
        return None;
    }
    let (x, y, right, bottom, w, h) = bbox_parts(block.bbox);
    if w <= 0.0
        || h <= 0.0
        || x < 0.0
        || y < 0.0
        || right > page.width * 1.005
        || bottom > page.height * 1.005
    {
        return None;
    }
    Some(Rect::from_xywh(
        Pt(x as f32 / page.width as f32 * size.0),
        Pt((1.0 - bottom as f32 / page.height as f32) * size.1),
        Pt(w as f32 / page.width as f32 * size.0),
        Pt(h as f32 / page.height as f32 * size.1),
    ))
}

fn block_text(block: &LayoutBlock) -> String {
    let role = classify(&block.label);
    let text = if matches!(
        role,
        BlockRole::DocTitle | BlockRole::Heading | BlockRole::FigureCaption | BlockRole::Image
    ) {
        strip_html(&block.text)
    } else {
        block.text.clone()
    };
    let text = clean_block_text(&text);
    if matches!(
        role,
        BlockRole::DocTitle | BlockRole::Heading | BlockRole::FigureCaption
    ) {
        repair_short_vertical_lines(&text)
    } else {
        text
    }
}

fn layout_font(
    font: &ParsedFont,
    block: &LayoutBlock,
    rect: &Rect,
    font_scale: f32,
) -> Option<f32> {
    let role = classify(&block.label);
    if role == BlockRole::Image {
        return Some(MIN_LAYOUT_FONT);
    }
    let rows = if role == BlockRole::Table {
        table_rows(&block.text)
    } else {
        Vec::new()
    };
    let text = block_text(block);
    let height = |size| {
        if rows.is_empty() {
            wrap_measured(font, &text, rect.width.0, size).len() as f32 * size * 1.35
        } else {
            table_height(font, &rows, rect.width.0, size)
        }
    };
    let minimum = MIN_LAYOUT_FONT * font_scale.clamp(0.5, 2.0);
    let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
    if rect.width.0 < minimum
        || height(minimum) > rect.height.0
        || cols as f32 * (minimum + 8.0) > rect.width.0
    {
        return None;
    }
    let mut low = minimum;
    let mut high = role_style(role, font_scale).size.max(minimum);
    for _ in 0..12 {
        let size = (low + high) / 2.0;
        if height(size) <= rect.height.0 {
            low = size;
        } else {
            high = size;
        }
    }
    Some(low)
}

fn image_crop(
    image: &image::RgbImage,
    page: &LayoutPage,
    block: &LayoutBlock,
) -> Option<image::RgbImage> {
    let (x, y, right, bottom, _, _) = bbox_parts(block.bbox);
    let (sx, sy) = if page.dimensions_approximate {
        let scale = ((image.width().max(image.height()) as f64) / page.width.max(page.height))
            .min((image.width().min(image.height()) as f64) / page.width.min(page.height));
        (scale, scale)
    } else {
        (
            image.width() as f64 / page.width,
            image.height() as f64 / page.height,
        )
    };
    let left = (x * sx).floor().clamp(0.0, image.width() as f64) as u32;
    let top = (y * sy).floor().clamp(0.0, image.height() as f64) as u32;
    let right = (right * sx).ceil().clamp(0.0, image.width() as f64) as u32;
    let bottom = (bottom * sy).ceil().clamp(0.0, image.height() as f64) as u32;
    if right <= left || bottom <= top {
        return None;
    }
    Some(image::imageops::crop_imm(image, left, top, right - left, bottom - top).to_image())
}

fn render_pdf_part(
    doc: &mut PdfDocument,
    font_id: &FontId,
    font: &ParsedFont,
    part: &PdfExportPart,
    options: &LayoutPdfExportOptions,
    pages: &mut Vec<PdfPage>,
    warnings: &mut Vec<String>,
) -> AppResult<()> {
    for article in &part.articles {
        let compared = options.with_source;
        if compared && article.images.is_empty() {
            return Err(AppError::Config(
                "报道原图缺失，无法生成对照 / Missing article source".into(),
            ));
        }
        let mut flow = Flow::new(font_id, font, options.margin_scale);
        if compared {
            flow.configure(841.89, 595.28, 440.945, 372.945, 28.0);
        }
        flow.emit_block(
            BlockRole::Heading,
            &format!("{} · {}", part.name, article.title),
            1.0,
        );
        flow.emit_rich_text(&article.body, 1.0);
        let mut ops = flow.finish();
        if compared {
            let mut index = 0;
            let mut top = 567.28;
            for source in &article.images {
                let (id, w, h) = add_image(doc, decode_source(source)?)?;
                let width = 372.945;
                let scale = (width / w as f32).min(539.28 / h as f32);
                let height = h as f32 * scale;
                if top - height < 28.0 {
                    index += 1;
                    top = 567.28;
                }
                while ops.len() <= index {
                    ops.push(Vec::new());
                }
                place_image(
                    &mut ops[index],
                    &id,
                    (w, h),
                    &Rect::from_xywh(Pt(28.0), Pt(top - height), Pt(width), Pt(height)),
                );
                top -= height + 16.0;
            }
        }
        for (index, mut operations) in ops.into_iter().enumerate() {
            let footer = format!("{} · {} · {}", part.name, article.title, index + 1);
            let footer = wrap_measured(font, &footer, if compared { 372.945 } else { 480.0 }, 7.0)
                .into_iter()
                .next()
                .unwrap_or_default();
            draw_line(
                &mut operations,
                font_id,
                &footer,
                if compared { 440.945 } else { MARGIN_X_PT },
                12.0,
                7.0,
                role_style(BlockRole::PageNumber, 1.0).color,
            );
            pages.push(PdfPage::new(
                pt_to_mm(if compared { 841.89 } else { A4_W_PT }),
                pt_to_mm(if compared { 595.28 } else { A4_H_PT }),
                operations,
            ));
        }
    }
    let repeated = infer_repeated_furniture_texts(&part.document);
    for page in &part.document.pages {
        let compared = options.with_source;
        let source = part
            .source_images
            .get(&page.index)
            .map(decode_source)
            .transpose()?;
        if compared && source.is_none() {
            return Err(AppError::Config(format!(
                "{} · 第 {} 页原图缺失，无法生成对照",
                part.name, page.index
            )));
        }
        let size = if page.width > 0.0
            && page.height > 0.0
            && page.width.is_finite()
            && page.height.is_finite()
        {
            let scale = A4_H_PT / page.width.max(page.height) as f32;
            (page.width as f32 * scale, page.height as f32 * scale)
        } else {
            (A4_W_PT, A4_H_PT)
        };
        let blocks: Vec<_> = ordered_blocks(page)
            .into_iter()
            .filter(|block| {
                include_in_reading(classify(&block.label), options)
                    && !should_skip_inferred_furniture(page, block, &repeated, options)
                    && !is_known_scanner_artifact(&clean_block_text(&block.text))
            })
            .collect();
        let positioned: Option<Vec<_>> = if page.dimensions_approximate {
            None
        } else {
            blocks
                .iter()
                .map(|block| {
                    let rect = block_rect(page, block, size)?;
                    let size = layout_font(font, block, &rect, options.font_scale)?;
                    Some((*block, rect, size))
                })
                .collect()
        };
        // Overlapping OCR boxes cannot be trusted as separate text regions.
        let overlaps = positioned.as_ref().is_some_and(|items| {
            items.iter().enumerate().any(|(i, (_, a, _))| {
                items[i + 1..].iter().any(|(_, b, _)| {
                    let area = (a.x.0 + a.width.0).min(b.x.0 + b.width.0) - a.x.0.max(b.x.0);
                    let height = (a.y.0 + a.height.0).min(b.y.0 + b.height.0) - a.y.0.max(b.y.0);
                    area > 0.0
                        && height > 0.0
                        && area * height
                            > 0.08 * (a.width.0 * a.height.0).min(b.width.0 * b.height.0)
                })
            })
        });
        let label = format!("{} · 第 {} 页", part.name, page.index);
        if let Some(items) = positioned.filter(|_| !overlaps) {
            let offset = if compared { size.0 } else { 0.0 };
            let mut ops = Vec::new();
            if compared {
                let (id, w, h) = add_image(doc, source.as_ref().unwrap().clone())?;
                place_image(
                    &mut ops,
                    &id,
                    (w, h),
                    &Rect::from_wh(Pt(size.0), Pt(size.1)),
                );
            }
            for (block, mut rect, font_size) in items {
                rect.x.0 += offset;
                let role = classify(&block.label);
                if role == BlockRole::Image {
                    if let Some(crop) = source
                        .as_ref()
                        .and_then(|image| image_crop(image, page, block))
                    {
                        let (id, w, h) = add_image(doc, crop)?;
                        place_image(&mut ops, &id, (w, h), &rect);
                    } else {
                        draw_cell(
                            &mut ops,
                            font_id,
                            &["图片原图缺失".into()],
                            &rect,
                            font_size.min(8.0),
                        );
                        warnings.push(format!("{label}：图片原图缺失"));
                    }
                } else if role == BlockRole::Table && !table_rows(&block.text).is_empty() {
                    draw_table(
                        &mut ops,
                        font_id,
                        font,
                        &table_rows(&block.text),
                        &rect,
                        font_size,
                    );
                } else {
                    let text = block_text(block);
                    for (i, line) in wrap_measured(font, &text, rect.width.0, font_size)
                        .iter()
                        .enumerate()
                    {
                        draw_line(
                            &mut ops,
                            font_id,
                            line,
                            rect.x.0,
                            rect.y.0 + rect.height.0 - font_size - i as f32 * font_size * 1.35,
                            font_size,
                            role_style(role, 1.0).color,
                        );
                    }
                }
            }
            // A footer outside source content preserves file/page identity in merged PDFs.
            draw_line(
                &mut ops,
                font_id,
                &label,
                offset + 8.0,
                -12.0,
                8.0,
                role_style(BlockRole::PageNumber, 1.0).color,
            );
            // Leave 22pt beneath the source canvas, shifting the page content up.
            // The source-sized page itself remains unscaled.
            for op in &mut ops {
                if let Op::SetTextCursor { pos } = op {
                    pos.y.0 += 22.0;
                }
                if let Op::UseXobject { transform, .. } = op {
                    transform.translate_y =
                        Some(Pt(transform.translate_y.unwrap_or(Pt(0.0)).0 + 22.0));
                }
                if let Op::DrawLine { line } = op {
                    for point in &mut line.points {
                        point.p.y.0 += 22.0;
                    }
                }
            }
            pages.push(PdfPage::new(
                pt_to_mm(size.0 + offset),
                pt_to_mm(size.1 + 22.0),
                ops,
            ));
        } else {
            let mut flow = Flow::new(font_id, font, options.margin_scale);
            if compared {
                flow.configure(
                    A4_W_PT * 2.0,
                    A4_H_PT,
                    A4_W_PT + MARGIN_X_PT,
                    A4_W_PT - MARGIN_X_PT * 2.0,
                    MARGIN_TOP_PT,
                );
            }
            flow.emit_anchor(&label, 1.0);
            for block in blocks {
                let role = classify(&block.label);
                if role == BlockRole::Image {
                    if let Some(crop) = source
                        .as_ref()
                        .and_then(|image| image_crop(image, page, block))
                    {
                        let (id, w, h) = add_image(doc, crop)?;
                        flow.emit_image(&id, w, h);
                    } else {
                        flow.emit_block(BlockRole::Image, "图片原图缺失", 1.0);
                        warnings.push(format!("{label}：图片原图缺失"));
                    }
                } else if role == BlockRole::Table {
                    flow.emit_table(&table_rows(&block.text), &block.text, options.font_scale);
                } else {
                    flow.emit_block(role, &block_text(block), options.font_scale);
                }
            }
            let source_id = source
                .as_ref()
                .filter(|_| compared)
                .map(|image| add_image(doc, image.clone()))
                .transpose()?;
            for (index, mut ops) in flow.finish().into_iter().enumerate() {
                let footer = format!("{label} · {}", index + 1);
                let footer = wrap_measured(font, &footer, A4_W_PT - MARGIN_X_PT * 2.0, 7.0)
                    .into_iter()
                    .next()
                    .unwrap_or_default();
                draw_line(
                    &mut ops,
                    font_id,
                    &footer,
                    if compared {
                        A4_W_PT + MARGIN_X_PT
                    } else {
                        MARGIN_X_PT
                    },
                    20.0,
                    7.0,
                    role_style(BlockRole::PageNumber, 1.0).color,
                );
                if let Some((id, w, h)) = &source_id {
                    place_image(
                        &mut ops,
                        id,
                        (*w, *h),
                        &Rect::from_xywh(
                            Pt(20.0),
                            Pt(20.0),
                            Pt(A4_W_PT - 40.0),
                            Pt(A4_H_PT - 40.0),
                        ),
                    );
                }
                pages.push(PdfPage::new(
                    pt_to_mm(if compared { A4_W_PT * 2.0 } else { A4_W_PT }),
                    pt_to_mm(A4_H_PT),
                    ops,
                ));
            }
        }
    }
    Ok(())
}

/// Per-role visual style for the flowing PDF.
#[derive(Clone)]
struct RoleStyle {
    size: f32,
    line_height: f32,
    gap_before: f32,
    gap_after: f32,
    indent: f32,
    color: Color,
}

fn role_style(role: BlockRole, font_scale: f32) -> RoleStyle {
    let near_black = Color::Rgb(Rgb::new(0.09, 0.09, 0.11, None));
    let muted = Color::Rgb(Rgb::new(0.42, 0.44, 0.48, None));
    let s = |v: f32| v * font_scale;
    match role {
        BlockRole::DocTitle => RoleStyle {
            size: s(17.0),
            line_height: 1.3,
            gap_before: 18.0,
            gap_after: 12.0,
            indent: 0.0,
            color: near_black,
        },
        BlockRole::Heading => RoleStyle {
            size: s(13.5),
            line_height: 1.3,
            gap_before: 13.0,
            gap_after: 5.0,
            indent: 0.0,
            color: near_black,
        },
        BlockRole::FigureCaption => RoleStyle {
            size: s(10.0),
            line_height: 1.35,
            gap_before: 4.0,
            gap_after: 6.0,
            indent: 0.0,
            color: muted,
        },
        BlockRole::Body | BlockRole::Header | BlockRole::Footer => RoleStyle {
            size: s(10.5),
            line_height: 1.5,
            gap_before: 0.0,
            gap_after: 6.0,
            indent: s(10.5) * 2.0,
            color: near_black,
        },
        BlockRole::Footnote | BlockRole::Aside => RoleStyle {
            size: s(9.0),
            line_height: 1.4,
            gap_before: 2.0,
            gap_after: 4.0,
            indent: 0.0,
            color: muted,
        },
        BlockRole::Table | BlockRole::Image => RoleStyle {
            size: s(9.5),
            line_height: 1.4,
            gap_before: 4.0,
            gap_after: 6.0,
            indent: 0.0,
            color: Color::Rgb(Rgb::new(0.3, 0.32, 0.36, None)),
        },
        BlockRole::PageNumber => RoleStyle {
            size: s(9.0),
            line_height: 1.3,
            gap_before: 14.0,
            gap_after: 8.0,
            indent: 0.0,
            color: muted,
        },
    }
}

struct Flow<'a> {
    font_id: &'a FontId,
    font: &'a ParsedFont,
    margin_x: f32,
    margin_top: f32,
    margin_bottom: f32,
    pages: Vec<Vec<Op>>,
    cur: Vec<Op>,
    y: f32,
    started: bool,
    page_height: f32,
    text_width: f32,
}

impl<'a> Flow<'a> {
    fn new(font_id: &'a FontId, font: &'a ParsedFont, margin_scale: f32) -> Self {
        let margin_x = MARGIN_X_PT * margin_scale;
        let margin_top = MARGIN_TOP_PT * margin_scale;
        let margin_bottom = MARGIN_BOTTOM_PT * margin_scale;
        Flow {
            font_id,
            font,
            margin_x,
            margin_top,
            margin_bottom,
            pages: Vec::new(),
            cur: Vec::new(),
            y: A4_H_PT - margin_top,
            started: false,
            page_height: A4_H_PT,
            text_width: (A4_W_PT - margin_x * 2.0).max(72.0),
        }
    }

    fn content_width(&self) -> f32 {
        self.text_width
    }

    fn configure(&mut self, _width: f32, height: f32, x: f32, text_width: f32, margin: f32) {
        self.page_height = height;
        self.margin_x = x;
        self.text_width = text_width;
        self.margin_top = margin;
        self.margin_bottom = margin;
        self.y = height - margin;
    }

    fn new_page(&mut self) {
        self.pages.push(mem::take(&mut self.cur));
        self.y = self.page_height - self.margin_top;
    }

    /// Ensure at least `line_h` fits; break to a new page if not.
    fn ensure(&mut self, line_h: f32) {
        if self.started && self.y - line_h < self.margin_bottom {
            self.new_page();
        }
    }

    fn emit_anchor(&mut self, label: &str, font_scale: f32) {
        let style = role_style(BlockRole::PageNumber, font_scale);
        self.emit_paragraph(&format!("〔{label}〕"), style);
    }

    fn emit_block(&mut self, role: BlockRole, text: &str, font_scale: f32) {
        let style = role_style(role, font_scale);
        let pdf_text = pdf_text_for_role(role, text);
        self.emit_paragraph(&pdf_text, style);
    }

    fn emit_paragraph(&mut self, text: &str, style: RoleStyle) {
        let line_h = style.size * style.line_height;
        // Gap before (skipped at the very top of the document / a fresh page).
        if self.started && self.y < self.page_height - self.margin_top - 0.01 {
            self.y -= style.gap_before;
        }
        let font_id = self.font_id;
        // Reserve the indent during measurement as well as drawing.
        let lines = wrap_measured(
            self.font,
            text,
            (self.content_width() - style.indent).max(style.size),
            style.size,
        );
        for (idx, line) in lines.iter().enumerate() {
            self.ensure(line_h);
            self.started = true;
            let baseline = self.y - style.size;
            let x = self.margin_x + if idx == 0 { style.indent } else { 0.0 };
            draw_line(
                &mut self.cur,
                font_id,
                line,
                x,
                baseline,
                style.size,
                style.color.clone(),
            );
            self.y -= line_h;
        }
        self.y -= style.gap_after;
    }

    fn emit_image(&mut self, id: &XObjectId, width: u32, height: u32) {
        let scale = (self.content_width() / width.max(1) as f32)
            .min((self.page_height - self.margin_top - self.margin_bottom) / height.max(1) as f32);
        let h = height as f32 * scale;
        self.ensure(h);
        let rect = Rect::from_xywh(
            Pt(self.margin_x),
            Pt(self.y - h),
            Pt(self.content_width()),
            Pt(h),
        );
        place_image(&mut self.cur, id, (width, height), &rect);
        self.y -= h + 10.0;
        self.started = true;
    }

    fn emit_table(&mut self, rows: &[Vec<String>], original: &str, font_scale: f32) {
        if rows.is_empty() {
            self.emit_block(
                BlockRole::Table,
                &pdf_text_for_role(BlockRole::Table, original),
                font_scale,
            );
            return;
        }
        let size = (9.5 * font_scale).clamp(8.0, 16.0);
        let line_height = size * 1.35;
        let cols = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
        let width = self.content_width() / cols as f32;
        if width < size + 8.0 {
            for row in rows {
                self.emit_block(BlockRole::Table, &row.join(" | "), font_scale);
            }
            return;
        }
        for row in rows {
            let cells: Vec<_> = (0..cols)
                .map(|i| {
                    wrap_measured(
                        self.font,
                        row.get(i).map(String::as_str).unwrap_or(""),
                        (width - 8.0).max(size),
                        size,
                    )
                })
                .collect();
            let count = cells.iter().map(Vec::len).max().unwrap_or(1);
            let full_height = count as f32 * line_height + 8.0;
            // Keep an ordinary row together; very tall rows continue by lines.
            if full_height <= self.page_height - self.margin_top - self.margin_bottom {
                self.ensure(full_height);
            }
            let mut at = 0;
            while at < count {
                self.ensure(line_height + 8.0);
                let take = (((self.y - self.margin_bottom - 8.0) / line_height)
                    .floor()
                    .max(1.0) as usize)
                    .min(count - at);
                let h = take as f32 * line_height + 8.0;
                for (i, lines) in cells.iter().enumerate() {
                    let fragment = &lines[at.min(lines.len())..(at + take).min(lines.len())];
                    draw_cell(
                        &mut self.cur,
                        self.font_id,
                        fragment,
                        &Rect::from_xywh(
                            Pt(self.margin_x + i as f32 * width),
                            Pt(self.y - h),
                            Pt(width),
                            Pt(h),
                        ),
                        size,
                    );
                }
                self.y -= h;
                self.started = true;
                at += take;
                if at < count {
                    self.new_page();
                }
            }
        }
        self.y -= 10.0;
    }

    fn emit_rich_text(&mut self, text: &str, scale: f32) {
        let mut rest = text;
        while let Some(start) = rest.to_ascii_lowercase().find("<table") {
            self.emit_markdown_lines(&rest[..start], scale);
            let table = &rest[start..];
            let Some(end) = table.to_ascii_lowercase().find("</table>") else {
                self.emit_markdown_lines(table, scale);
                return;
            };
            let end = end + "</table>".len();
            self.emit_table(&table_rows(&table[..end]), &table[..end], scale);
            rest = &table[end..];
        }
        self.emit_markdown_lines(rest, scale);
    }

    fn emit_markdown_lines(&mut self, text: &str, scale: f32) {
        let mut table = String::new();
        for line in text.lines() {
            if line.trim().starts_with('|') {
                table.push_str(line);
                table.push('\n');
                continue;
            }
            if !table.is_empty() {
                self.emit_table(&table_rows(&table), &table, scale);
                table.clear();
            }
            let line = line.trim();
            if line.is_empty() {
                self.y -= 5.0;
                continue;
            }
            let (role, body) = if line.starts_with('#') {
                (BlockRole::Heading, line.trim_start_matches('#').trim())
            } else {
                (BlockRole::Body, line)
            };
            self.emit_block(role, &clean_block_text(&strip_html(body)), scale);
        }
        if !table.is_empty() {
            self.emit_table(&table_rows(&table), &table, scale);
        }
    }

    fn finish(mut self) -> Vec<Vec<Op>> {
        if !self.cur.is_empty() || self.pages.is_empty() {
            self.pages.push(mem::take(&mut self.cur));
        }
        self.pages
    }
}

fn draw_line(
    ops: &mut Vec<Op>,
    font_id: &FontId,
    text: &str,
    x: f32,
    y: f32,
    size: f32,
    color: Color,
) {
    ops.push(Op::StartTextSection);
    ops.push(Op::SetFillColor { col: color });
    ops.push(Op::SetFont {
        font: PdfFontHandle::External(font_id.clone()),
        size: Pt(size),
    });
    ops.push(Op::SetTextCursor {
        pos: Point { x: Pt(x), y: Pt(y) },
    });
    ops.push(Op::ShowText {
        items: vec![TextItem::Text(text.to_string())],
    });
    ops.push(Op::EndTextSection);
}

fn pdf_text_for_role(role: BlockRole, text: &str) -> String {
    if role == BlockRole::Table && looks_like_html_table(text) {
        let plain = html_table_to_plain_text(text);
        if !plain.trim().is_empty() {
            return plain;
        }
    }
    text.to_string()
}

fn looks_like_html_table(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("<table") || lower.contains("<tr") || lower.contains("<td")
}

fn html_table_to_plain_text(text: &str) -> String {
    let mut out = String::new();
    let mut tag = String::new();
    let mut in_tag = false;

    for ch in text.chars() {
        if in_tag {
            if ch == '>' {
                apply_html_table_tag(&mut out, &tag);
                tag.clear();
                in_tag = false;
            } else {
                tag.push(ch);
            }
            continue;
        }
        if ch == '<' {
            in_tag = true;
        } else {
            out.push(ch);
        }
    }

    normalize_table_text(&decode_basic_html_entities(&out))
}

fn apply_html_table_tag(out: &mut String, raw_tag: &str) {
    let tag = raw_tag
        .trim()
        .trim_start_matches('/')
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match tag.as_str() {
        "tr" if !out.ends_with('\n') => out.push('\n'),
        "td" | "th" if !out.ends_with('|') && !out.ends_with('\n') => out.push('|'),
        "br" => out.push('\n'),
        _ => {}
    }
}

fn normalize_table_text(text: &str) -> String {
    text.lines()
        .map(|line| {
            line.split('|')
                .map(str::trim)
                .filter(|cell| !cell.is_empty())
                .collect::<Vec<_>>()
                .join(" | ")
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn decode_basic_html_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn estimated_char_width(ch: char) -> f32 {
    if ch.is_ascii_whitespace() {
        0.3
    } else if ch.is_ascii() {
        0.52
    } else if is_full_width_char(ch) {
        1.0
    } else {
        0.82
    }
}

fn is_full_width_char(ch: char) -> bool {
    matches!(
        ch as u32,
        0x1100..=0x11ff
            | 0x2e80..=0x9fff
            | 0xac00..=0xd7af
            | 0xf900..=0xfaff
            | 0xff00..=0xffef
            | 0x20000..=0x2ffff
    )
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

pub fn export_reading_markdown_to_path(
    req: LayoutPdfExportRequest,
) -> AppResult<ReadingMarkdownExportResult> {
    let target_path = validate_target(&req.target_path, &req.document)?;
    let mut warnings = Vec::new();
    if req.options.mode == LayoutPdfExportMode::Bbox {
        warnings.push(
            carpo_core::tr!(
                "bbox 版式重建已改为阅读版导出",
                "bbox layout reconstruction now exports the reading view instead"
            )
            .to_string(),
        );
    }
    let items = build_reading_items(&req.document, &req.options, &mut warnings);

    let mut out = String::new();
    for item in &items {
        match (&item.text, &item.anchor) {
            (None, Some(label)) => {
                push_para(&mut out, &format!("〔{label}〕"));
            }
            (Some(text), _) => push_markdown_block(&mut out, item.role, text),
            _ => {}
        }
    }
    let markdown = out.trim_start_matches('\n').to_string();

    fs::write(&target_path, markdown)
        .map_err(|e| AppError::Internal(format!("write {}: {e}", target_path.display())))?;

    let warning_count = warnings.len() as u32;
    Ok(ReadingMarkdownExportResult {
        target_path: target_path.display().to_string(),
        page_count: req.document.pages.len() as u32,
        warning_count,
        warnings: warnings.into_iter().take(MAX_RETURNED_WARNINGS).collect(),
    })
}

fn push_para(out: &mut String, text: &str) {
    if !out.is_empty() && !out.ends_with("\n\n") {
        out.push_str("\n\n");
    }
    out.push_str(text);
    out.push_str("\n\n");
}

fn push_markdown_block(out: &mut String, role: BlockRole, text: &str) {
    match role {
        BlockRole::DocTitle => push_para(out, &format!("# {}", one_line(text))),
        BlockRole::Heading => push_para(out, &format!("## {}", one_line(text))),
        BlockRole::FigureCaption => push_para(out, &format!("### {}", one_line(text))),
        BlockRole::Footnote | BlockRole::Aside => {
            let quoted = text
                .split('\n')
                .map(|l| format!("> {l}"))
                .collect::<Vec<_>>()
                .join("\n");
            push_para(out, &quoted);
        }
        BlockRole::Table => {
            // Keep table content verbatim (often already a Markdown/HTML table).
            push_para(out, text);
        }
        BlockRole::Image
        | BlockRole::Body
        | BlockRole::Header
        | BlockRole::Footer
        | BlockRole::PageNumber => push_para(out, text),
    }
}

fn one_line(text: &str) -> String {
    text.split('\n')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn validate_target(target_path: &str, document: &LayoutDocument) -> AppResult<PathBuf> {
    if target_path.trim().is_empty() {
        return Err(AppError::Config(
            carpo_core::tr!("缺少导出路径", "No export path given").into(),
        ));
    }
    if document.pages.is_empty() {
        return Err(AppError::Config(
            carpo_core::tr!(
                "没有可导出的版式页面",
                "There are no layout pages to export"
            )
            .into(),
        ));
    }
    let path = PathBuf::from(target_path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AppError::FileNotFound(parent.display().to_string()));
        }
    }
    Ok(path)
}

fn collect_item_chars(items: &[ReadingItem]) -> BTreeSet<char> {
    let mut chars: BTreeSet<char> = carpo_core::tr!(
        "Carpo源文件第页〔〕［］图表格未嵌入",
        "Carpo[]:Source page image table not embedded"
    )
    .chars()
    .collect();
    for item in items {
        if let Some(text) = &item.text {
            chars.extend(text.chars().filter(|c| !c.is_control()));
        }
        if let Some(anchor) = &item.anchor {
            chars.extend(anchor.chars().filter(|c| !c.is_control()));
        }
    }
    chars
}

fn push_missing_char_warning(loaded_font: &LoadedFont, warnings: &mut Vec<String>) {
    if loaded_font.missing_chars.is_empty() {
        return;
    }
    let preview: String = loaded_font.missing_chars.iter().take(12).collect();
    warnings.push(carpo_core::trf!(
        "字体 {} 缺少 {} 个字符（{}{}），缺字会显示为空白或替代字形",
        "Font {} is missing {} characters ({}{}) — they render as blanks or fallback glyphs",
        loaded_font.path.display(),
        loaded_font.missing_chars.len(),
        preview,
        if loaded_font.missing_chars.len() > 12 {
            "…"
        } else {
            ""
        }
    ));
}

#[derive(Debug)]
struct FontCandidate {
    path: PathBuf,
    index: u32,
}

struct LoadedFont {
    font: ParsedFont,
    path: PathBuf,
    missing_chars: Vec<char>,
}

fn load_cjk_font(required_chars: &BTreeSet<char>) -> AppResult<LoadedFont> {
    let mut best: Option<(FontCandidate, Vec<u8>, usize)> = None;
    for candidate in font_candidates() {
        let Ok(bytes) = fs::read(&candidate.path) else {
            continue;
        };
        let Ok(face) = Face::parse(&bytes, candidate.index) else {
            continue;
        };
        let supported = required_chars
            .iter()
            .filter(|ch| face.glyph_index(**ch).is_some())
            .count();
        if supported == required_chars.len() {
            return build_loaded_font(candidate, bytes, required_chars);
        }
        if best
            .as_ref()
            .map_or(true, |(_, _, best_supported)| supported > *best_supported)
        {
            best = Some((candidate, bytes, supported));
        }
    }

    if let Some((candidate, bytes, supported)) = best {
        if supported > 0 {
            return build_loaded_font(candidate, bytes, required_chars);
        }
    }

    Err(AppError::Config(
        carpo_core::tr!(
            "未找到可用中文字体；请安装 Noto Sans CJK、Arial Unicode、微软雅黑或宋体后重试",
            "No usable CJK font found — install Noto Sans CJK, Arial Unicode, Microsoft YaHei or SimSun and try again"
        )
        .into(),
    ))
}

fn build_loaded_font(
    candidate: FontCandidate,
    bytes: Vec<u8>,
    required_chars: &BTreeSet<char>,
) -> AppResult<LoadedFont> {
    let face = Face::parse(&bytes, candidate.index).map_err(|e| {
        AppError::Internal(format!("parse font {}: {e:?}", candidate.path.display()))
    })?;
    let units_per_em = face.units_per_em();
    let metrics = FontMetrics {
        ascent: face.ascender(),
        descent: face.descender(),
    };
    let mut codepoint_to_glyph: BTreeMap<u32, u16> = BTreeMap::new();
    let mut glyph_widths: BTreeMap<u16, u16> = BTreeMap::new();
    let mut missing_chars = Vec::new();
    for ch in required_chars {
        if let Some(glyph) = face.glyph_index(*ch) {
            codepoint_to_glyph.insert(*ch as u32, glyph.0);
            let width = face
                .glyph_hor_advance(glyph)
                .unwrap_or(units_per_em.saturating_div(2));
            glyph_widths.insert(glyph.0, width);
        } else {
            missing_chars.push(*ch);
        }
    }
    let font = ParsedFont::with_glyph_data(
        bytes,
        candidate.index,
        candidate
            .path
            .file_name()
            .and_then(|s| s.to_str())
            .map(str::to_string),
        codepoint_to_glyph,
        glyph_widths,
        units_per_em,
        metrics,
    );
    Ok(LoadedFont {
        font,
        path: candidate.path,
        missing_chars,
    })
}

fn font_candidates() -> Vec<FontCandidate> {
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    {
        out.extend(
            [
                "/System/Library/Fonts/Supplemental/NISC18030.ttf",
                "/Library/Fonts/Arial Unicode.ttf",
                "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
                "/System/Library/Fonts/Hiragino Sans GB.ttc",
                "/System/Library/Fonts/STHeiti Medium.ttc",
                "/System/Library/Fonts/STHeiti Light.ttc",
                "/System/Library/Fonts/Supplemental/Songti.ttc",
            ]
            .into_iter()
            .map(|path| FontCandidate {
                path: PathBuf::from(path),
                index: 0,
            }),
        );
    }
    #[cfg(target_os = "windows")]
    {
        let fonts_dir = env::var_os("WINDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join("Fonts");
        for file in ["msyh.ttc", "simsun.ttc", "simhei.ttf", "msyh.ttf"] {
            out.push(FontCandidate {
                path: fonts_dir.join(file),
                index: 0,
            });
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        out.extend(
            [
                "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            ]
            .into_iter()
            .map(|path| FontCandidate {
                path: PathBuf::from(path),
                index: 0,
            }),
        );
    }
    if let Some(path) = env::var_os("CARPO_LAYOUT_PDF_FONT") {
        out.insert(
            0,
            FontCandidate {
                path: PathBuf::from(path),
                index: env::var("CARPO_LAYOUT_PDF_FONT_INDEX")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0),
            },
        );
    }
    dedupe_candidates(out)
}

fn dedupe_candidates(candidates: Vec<FontCandidate>) -> Vec<FontCandidate> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for candidate in candidates {
        let key = (candidate.path.clone(), candidate.index);
        if seen.insert(key) {
            out.push(candidate);
        }
    }
    out
}

fn pt_to_mm(pt: f32) -> Mm {
    Mm(pt * 0.352_778)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(label: &str, text: &str, bbox: [f64; 4], order: Option<u32>) -> LayoutBlock {
        LayoutBlock {
            label: label.into(),
            text: text.into(),
            bbox,
            polygon: None,
            order,
            image_ref: None,
        }
    }

    fn doc(pages: Vec<LayoutPage>) -> LayoutDocument {
        LayoutDocument {
            source: "paddle".into(),
            pages,
        }
    }

    #[test]
    fn short_vertical_lines_are_joined_for_reading() {
        assert_eq!(
            repair_short_vertical_lines("新聞\n\n之\n\n採\n\n集"),
            "新聞之採集"
        );
        assert_eq!(
            repair_short_vertical_lines("第三節\n\n造題時\n\n應注意之\n\n點"),
            "第三節造題時應注意之點"
        );
        assert_eq!(
            repair_short_vertical_lines("第一章\n\n新聞學之性質與重要"),
            "第一章\n\n新聞學之性質與重要"
        );
    }

    #[test]
    fn repeated_edge_body_text_is_filtered_as_running_header() {
        let d = doc(vec![
            LayoutPage {
                index: 1,
                width: 1000.0,
                height: 1500.0,
                blocks: vec![
                    block("text", "正文一", [200.0, 200.0, 800.0, 900.0], Some(1)),
                    block(
                        "vertical_text",
                        "新聞學第六章新聞之採集",
                        [40.0, 300.0, 85.0, 780.0],
                        Some(2),
                    ),
                ],
                dimensions_approximate: false,
            },
            LayoutPage {
                index: 2,
                width: 1000.0,
                height: 1500.0,
                blocks: vec![
                    block("text", "正文二", [200.0, 200.0, 800.0, 900.0], Some(1)),
                    block(
                        "vertical_text",
                        "新聞學第六章新聞之採集",
                        [42.0, 300.0, 87.0, 780.0],
                        Some(2),
                    ),
                ],
                dimensions_approximate: false,
            },
            LayoutPage {
                index: 3,
                width: 1000.0,
                height: 1500.0,
                blocks: vec![
                    block("text", "正文三", [200.0, 200.0, 800.0, 900.0], Some(1)),
                    block(
                        "vertical_text",
                        "新聞學第六章新聞之採集",
                        [44.0, 300.0, 89.0, 780.0],
                        Some(2),
                    ),
                ],
                dimensions_approximate: false,
            },
        ]);
        let mut warnings = Vec::new();
        let items = build_reading_items(&d, &LayoutPdfExportOptions::default(), &mut warnings);
        let texts = items
            .iter()
            .filter_map(|item| item.text.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(texts, vec!["正文一", "正文二", "正文三"]);
        assert!(warnings.iter().any(|w| w.contains("重复页眉/页脚")));

        let mut opts = LayoutPdfExportOptions::default();
        opts.include_header = true;
        let mut warnings = Vec::new();
        let items = build_reading_items(&d, &opts, &mut warnings);
        let texts = items
            .iter()
            .filter_map(|item| item.text.as_deref())
            .collect::<Vec<_>>();
        assert!(texts.contains(&"新聞學第六章新聞之採集"));
    }

    #[test]
    fn repeated_edge_heading_is_not_inferred_as_furniture() {
        let page = |index| LayoutPage {
            index,
            width: 1000.0,
            height: 1500.0,
            blocks: vec![block(
                "paragraph_title",
                "第六章新聞之採集",
                [40.0, 300.0, 85.0, 780.0],
                Some(1),
            )],
            dimensions_approximate: false,
        };
        let d = doc(vec![page(1), page(2), page(3)]);
        let mut warnings = Vec::new();
        let items = build_reading_items(&d, &LayoutPdfExportOptions::default(), &mut warnings);
        let heading_count = items
            .iter()
            .filter(|item| item.text.as_deref() == Some("第六章新聞之採集"))
            .count();
        assert_eq!(heading_count, 3);
        assert!(!warnings.iter().any(|w| w.contains("重复页眉/页脚")));
    }

    #[test]
    fn scanner_artifact_pages_keep_their_page_number_anchor() {
        // A page whose only blocks were filtered (scanner metadata) used to
        // vanish from the reading edition entirely. It now keeps its
        // page-number anchor, so collation against the source still lines
        // up — and the warning says so.
        let d = doc(vec![
            LayoutPage {
                index: 1,
                width: 1000.0,
                height: 1500.0,
                blocks: vec![block(
                    "algorithm",
                    "Images have been losslessly embedded. Information about the original file can be found in PDF attachments.\n{\"filename_decoded\":\"x.zip\",\"pdg_main_pages_found\":1}",
                    [50.0, 100.0, 950.0, 500.0],
                    Some(1),
                )],
                dimensions_approximate: false,
            },
            LayoutPage {
                index: 2,
                width: 1000.0,
                height: 1500.0,
                blocks: vec![block("text", "正文", [50.0, 100.0, 950.0, 500.0], Some(1))],
                dimensions_approximate: false,
            },
        ]);
        let mut warnings = Vec::new();
        let items = build_reading_items(&d, &LayoutPdfExportOptions::default(), &mut warnings);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].anchor.as_deref(), Some("源文件第 1 页"));
        assert_eq!(items[1].anchor.as_deref(), Some("源文件第 2 页"));
        assert_eq!(items[2].text.as_deref(), Some("正文"));
        assert!(warnings.iter().any(|w| w.contains("扫描/封装元数据")));
        assert!(warnings.iter().any(|w| w.contains("仅保留页码")));
    }

    #[test]
    fn emptied_page_keeps_its_anchor_and_drops_its_text() {
        // 条 8: a page the user emptied (`blocks: []`) must not resurrect the
        // old OCR text — the reading edition shows its page-number anchor and
        // nothing else.
        let d = doc(vec![LayoutPage {
            index: 1,
            width: 1000.0,
            height: 1500.0,
            blocks: vec![],
            dimensions_approximate: false,
        }]);
        let mut warnings = Vec::new();
        let items = build_reading_items(&d, &LayoutPdfExportOptions::default(), &mut warnings);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].anchor.as_deref(), Some("源文件第 1 页"));
        assert!(items[0].text.is_none());
        assert!(warnings.iter().any(|w| w.contains("仅保留页码")));
    }

    #[test]
    fn emptied_page_produces_nothing_without_page_numbers() {
        let d = doc(vec![LayoutPage {
            index: 1,
            width: 1000.0,
            height: 1500.0,
            blocks: vec![],
            dimensions_approximate: false,
        }]);
        let mut opts = LayoutPdfExportOptions::default();
        opts.include_page_number = false;
        let mut warnings = Vec::new();
        let items = build_reading_items(&d, &opts, &mut warnings);
        assert!(items.is_empty());
    }

    #[test]
    fn mixed_content_and_empty_pages_keep_anchor_order() {
        let d = doc(vec![
            LayoutPage {
                index: 1,
                width: 1000.0,
                height: 1500.0,
                blocks: vec![block(
                    "text",
                    "正文一",
                    [50.0, 100.0, 950.0, 500.0],
                    Some(1),
                )],
                dimensions_approximate: false,
            },
            LayoutPage {
                index: 2,
                width: 1000.0,
                height: 1500.0,
                blocks: vec![],
                dimensions_approximate: false,
            },
            LayoutPage {
                index: 3,
                width: 1000.0,
                height: 1500.0,
                blocks: vec![block(
                    "text",
                    "正文三",
                    [50.0, 100.0, 950.0, 500.0],
                    Some(1),
                )],
                dimensions_approximate: false,
            },
        ]);
        let mut warnings = Vec::new();
        let items = build_reading_items(&d, &LayoutPdfExportOptions::default(), &mut warnings);
        let anchors = items
            .iter()
            .filter_map(|item| item.anchor.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(
            anchors,
            vec!["源文件第 1 页", "源文件第 2 页", "源文件第 3 页"]
        );
        let texts = items
            .iter()
            .filter_map(|item| item.text.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(texts, vec!["正文一", "正文三"]);
        // Exactly one content-free page counted.
        assert!(warnings.iter().any(|w| w.contains("1 个源页")));
    }

    #[test]
    fn ordered_blocks_uses_block_order_then_falls_back_to_position() {
        // With order present.
        let page = LayoutPage {
            index: 1,
            width: 1000.0,
            height: 1500.0,
            blocks: vec![
                block("text", "second", [0.0, 0.0, 10.0, 10.0], Some(2)),
                block("text", "first", [0.0, 0.0, 10.0, 10.0], Some(1)),
            ],
            dimensions_approximate: false,
        };
        let ordered = ordered_blocks(&page);
        assert_eq!(ordered[0].text, "first");
        assert_eq!(ordered[1].text, "second");

        // Without order: top-to-bottom, then right-to-left (vertical books).
        let page = LayoutPage {
            index: 1,
            width: 1000.0,
            height: 1500.0,
            blocks: vec![
                block("vertical_text", "left", [100.0, 50.0, 200.0, 900.0], None),
                block("vertical_text", "right", [800.0, 50.0, 900.0, 900.0], None),
            ],
            dimensions_approximate: false,
        };
        let ordered = ordered_blocks(&page);
        assert_eq!(ordered[0].text, "right");
        assert_eq!(ordered[1].text, "left");
    }

    #[test]
    fn page_anchor_uses_source_index_not_ocr_number() {
        let page = LayoutPage {
            index: 1,
            width: 1000.0,
            height: 1500.0,
            blocks: vec![block("number", "890\n28", [0.0, 0.0, 10.0, 10.0], None)],
            dimensions_approximate: false,
        };
        assert_eq!(page_anchor_label(&page), "源文件第 1 页");

        let page = LayoutPage {
            index: 3,
            width: 1000.0,
            height: 1500.0,
            blocks: vec![block("number", "11", [0.0, 0.0, 10.0, 10.0], None)],
            dimensions_approximate: false,
        };
        assert_eq!(page_anchor_label(&page), "源文件第 3 页");
    }

    #[test]
    fn page_number_becomes_anchor_and_is_dropped_from_flow() {
        let opts = LayoutPdfExportOptions::default();
        let d = doc(vec![LayoutPage {
            index: 1,
            width: 1000.0,
            height: 1500.0,
            blocks: vec![
                block("number", "七", [0.0, 0.0, 10.0, 10.0], None),
                block("text", "正文", [0.0, 20.0, 100.0, 200.0], Some(1)),
            ],
            dimensions_approximate: false,
        }]);
        let mut warnings = Vec::new();
        let items = build_reading_items(&d, &opts, &mut warnings);
        // source-page anchor, then body "正文" — the bare OCR number is not a body item.
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].anchor.as_deref(), Some("源文件第 1 页"));
        assert!(items[0].text.is_none());
        assert_eq!(items[1].text.as_deref(), Some("正文"));
    }

    #[test]
    fn header_footer_filtered_by_default() {
        let opts = LayoutPdfExportOptions::default();
        let d = doc(vec![LayoutPage {
            index: 1,
            width: 1000.0,
            height: 1500.0,
            blocks: vec![
                block("header", "running head", [0.0, 0.0, 10.0, 10.0], Some(1)),
                block("text", "body", [0.0, 20.0, 100.0, 200.0], Some(2)),
                block(
                    "footer",
                    "running foot",
                    [0.0, 900.0, 100.0, 950.0],
                    Some(3),
                ),
            ],
            dimensions_approximate: false,
        }]);
        let mut warnings = Vec::new();
        let items = build_reading_items(&d, &opts, &mut warnings);
        let texts: Vec<_> = items.iter().filter_map(|i| i.text.as_deref()).collect();
        assert_eq!(texts, vec!["body"]);
    }

    #[test]
    fn markdown_export_restyles_headings_from_label() {
        let d = doc(vec![LayoutPage {
            index: 1,
            width: 1000.0,
            height: 1500.0,
            blocks: vec![
                block(
                    "paragraph_title",
                    "#### 颜序",
                    [0.0, 0.0, 10.0, 10.0],
                    Some(1),
                ),
                block("text", "正文段落", [0.0, 20.0, 100.0, 200.0], Some(2)),
            ],
            dimensions_approximate: false,
        }]);
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.md");
        let req = LayoutPdfExportRequest {
            document: d,
            target_path: target.display().to_string(),
            options: LayoutPdfExportOptions::default(),
        };
        let res = export_reading_markdown_to_path(req).unwrap();
        assert_eq!(res.page_count, 1);
        let md = std::fs::read_to_string(target).unwrap();
        assert!(md.contains("## 颜序"), "heading restyled, got: {md}");
        assert!(!md.contains("####"), "no stray markers, got: {md}");
        assert!(md.contains("〔源文件第 1 页〕"));
        assert!(md.contains("正文段落"));
    }

    #[test]
    fn html_is_stripped_from_image_captions_and_header_images_are_filtered() {
        let opts = LayoutPdfExportOptions::default();
        let d = doc(vec![LayoutPage {
            index: 1,
            width: 1000.0,
            height: 1500.0,
            blocks: vec![
                block(
                    "figure_title",
                    r#"<div style="text-align: center;"><div>邵飘萍</div></div>"#,
                    [0.0, 0.0, 10.0, 10.0],
                    Some(1),
                ),
                block(
                    "header_image",
                    r#"<div><img src="header.jpg" /></div>"#,
                    [0.0, 0.0, 10.0, 10.0],
                    Some(2),
                ),
                block(
                    "image",
                    r#"<div><img src="x.jpg" /></div>"#,
                    [0.0, 0.0, 10.0, 10.0],
                    Some(3),
                ),
            ],
            dimensions_approximate: false,
        }]);
        let mut warnings = Vec::new();
        let items = build_reading_items(&d, &opts, &mut warnings);
        let texts: Vec<_> = items.iter().filter_map(|i| i.text.as_deref()).collect();
        assert_eq!(texts, vec!["邵飘萍", "［图片：未嵌入］"]);
    }

    /// Manual end-to-end check against a real Paddle JSON export. Run with:
    /// `CARPO_SAMPLE_JSON=/path/book.json cargo test --manifest-path src-tauri/Cargo.toml
    ///  reading_export_from_real_json -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn reading_export_from_real_json() {
        let json_path = std::env::var("CARPO_SAMPLE_JSON").expect("set CARPO_SAMPLE_JSON");
        let import = carpo_core::ocr::paddle_json::analyze_path(std::path::Path::new(&json_path))
            .expect("analyze json");
        let stem = std::path::Path::new(&json_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("sample")
            .to_string();
        let out_dir = std::env::var("CARPO_OUT_DIR").unwrap_or_else(|_| "/tmp".into());
        let pdf = format!("{out_dir}/{stem}_阅读版.pdf");
        let md = format!("{out_dir}/{stem}_阅读版.md");
        let pdf_res = export_layout_pdf_to_path(LayoutPdfExportRequest {
            document: import.document.clone(),
            target_path: pdf.clone(),
            options: LayoutPdfExportOptions::default(),
        })
        .expect("export pdf");
        let md_res = export_reading_markdown_to_path(LayoutPdfExportRequest {
            document: import.document,
            target_path: md.clone(),
            options: LayoutPdfExportOptions::default(),
        })
        .expect("export md");
        println!("PDF  -> {pdf} ({} pages)", pdf_res.page_count);
        println!("MD   -> {md} ({} src pages)", md_res.page_count);
        for w in pdf_res.warnings.iter().chain(md_res.warnings.iter()) {
            println!("warn: {w}");
        }
    }
    fn rendered_text(pages: &[PdfPage]) -> String {
        pages
            .iter()
            .flat_map(|p| &p.ops)
            .filter_map(|op| match op {
                Op::ShowText { items } => Some(
                    items
                        .iter()
                        .filter_map(|i| {
                            if let TextItem::Text(text) = i {
                                Some(text.as_str())
                            } else {
                                None
                            }
                        })
                        .collect::<String>(),
                ),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn render_test_part(part: &PdfExportPart, compared: bool) -> AppResult<Vec<PdfPage>> {
        let chars = (32u8..127)
            .map(char::from)
            .chain("第页续图片原图缺失正文 ·：〔〕（）".chars())
            .collect();
        let font = load_cjk_font(&chars)?;
        let mut document = PdfDocument::new("test");
        let id = document.add_font(&font.font);
        let mut pages = Vec::new();
        render_pdf_part(
            &mut document,
            &id,
            &font.font,
            part,
            &LayoutPdfExportOptions {
                with_source: compared,
                include_images: true,
                include_header: true,
                include_footer: true,
                ..Default::default()
            },
            &mut pages,
            &mut Vec::new(),
        )?;
        Ok(pages)
    }

    fn source_image() -> ExportImage {
        let mut image = image::RgbImage::from_pixel(300, 440, image::Rgb([240, 240, 235]));
        for y in (20..420).step_by(16) {
            for x in 20..280 {
                image.put_pixel(x, y, image::Rgb([75, 75, 75]));
            }
        }
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80)
            .encode_image(&image)
            .unwrap();
        ExportImage {
            jpeg,
            width: 300,
            height: 440,
        }
    }

    fn sample_part() -> PdfExportPart {
        PdfExportPart { name: "Newspaper".into(), document: doc(vec![LayoutPage {
            index: 7, width: 1000.0, height: 1400.0, dimensions_approximate: false,
            blocks: vec![
                block("doc_title", "Newspaper / 1935", [60.0, 40.0, 940.0, 110.0], Some(1)),
                block("text", "First column. Source page seven. This paragraph stays in its original position.", [60.0, 160.0, 460.0, 550.0], Some(2)),
                block("text", "Second column. Complete text with punctuation, and an ending.", [540.0, 160.0, 940.0, 550.0], Some(3)),
                block("table", "<table><tr><th>Year</th><th>Count</th></tr><tr><td>1935</td><td>42</td></tr><tr><td></td><td>END-TABLE</td></tr></table>", [60.0, 640.0, 940.0, 900.0], Some(4)),
                block("image", "", [60.0, 980.0, 460.0, 1300.0], Some(5)),
            ],
        }]), source_images: BTreeMap::from([(7, source_image())]), articles: Vec::new() }
    }

    #[test]
    fn adaptive_layout_keeps_readable_columns_and_reflows_dense_pages_without_losing_text() {
        let mut part = sample_part();
        let pages = render_test_part(&part, false).unwrap();
        assert_eq!(pages.len(), 1);
        assert!(rendered_text(&pages).contains("END-TABLE"));
        assert!(pages[0]
            .ops
            .iter()
            .any(|op| matches!(op, Op::UseXobject { .. })));
        assert!(pages[0]
            .ops
            .iter()
            .all(|op| !matches!(op, Op::SetFont { size, .. } if size.0 < MIN_LAYOUT_FONT - 0.01)));
        part.document.pages[0].blocks[1].text = "DENSE-CONTENT ".repeat(1800) + "DENSE-END";
        let pages = render_test_part(&part, false).unwrap();
        assert!(pages.len() > 2);
        let text = rendered_text(&pages).replace('\n', "");
        assert_eq!(text.matches("DENSE-CONTENT").count(), 1800);
        assert!(text.contains("DENSE-END"));
        assert!(text.contains("END-TABLE"));
    }

    #[test]
    fn article_comparison_keeps_all_text_and_all_crops_even_when_one_side_finishes_first() {
        let mut part = sample_part();
        part.document.pages.clear();
        part.source_images.clear();
        part.articles = vec![PdfArticle {
            title: "Article across source pages".into(),
            body: "ARTICLE-TEXT ".repeat(1400) + "ARTICLE-END",
            images: vec![source_image(); 12],
        }];
        let pages = render_test_part(&part, true).unwrap();
        assert!(pages.len() >= 12);
        assert_eq!(
            pages
                .iter()
                .flat_map(|p| &p.ops)
                .filter(|op| matches!(op, Op::UseXobject { .. }))
                .count(),
            12
        );
        let text = rendered_text(&pages).replace('\n', "");
        assert_eq!(text.matches("ARTICLE-TEXT").count(), 1400);
        assert!(text.contains("ARTICLE-END"));
    }

    #[test]
    fn oversized_table_rows_continue_without_losing_cell_contents() {
        let mut part = sample_part();
        part.document.pages[0].blocks = vec![block(
            "table",
            &format!(
                "<table><tr><td>{}</td><td>RIGHT-END</td></tr></table>",
                "CELL ".repeat(3000) + "LEFT-END"
            ),
            [20.0, 20.0, 980.0, 1380.0],
            Some(1),
        )];
        let pages = render_test_part(&part, false).unwrap();
        assert!(pages.len() > 1);
        let text = rendered_text(&pages).replace('\n', "");
        assert_eq!(text.matches("CELL").count(), 3000);
        assert!(text.contains("LEFT-END"));
        assert!(text.contains("RIGHT-END"));
    }

    #[test]
    fn table_grid_preserves_empty_columns_and_reserves_spans() {
        let rows = table_rows("<table><tr><td rowspan='2'>A</td><td></td><td>C</td></tr><tr><td colspan='2'>D</td></tr></table>");
        assert_eq!(rows, vec![vec!["A", "", "C"], vec!["", "D", ""]]);
    }

    #[test]
    fn missing_comparison_source_does_not_overwrite_destination() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("existing.pdf");
        fs::write(&target, b"existing document").unwrap();
        let mut part = sample_part();
        part.source_images.clear();
        let result = export_layout_pdf_to_path(LayoutPdfExportRequest {
            document: doc(Vec::new()),
            target_path: target.to_string_lossy().into(),
            options: LayoutPdfExportOptions {
                with_source: true,
                parts: vec![part],
                ..Default::default()
            },
        });
        assert!(result.is_err());
        assert_eq!(fs::read(target).unwrap(), b"existing document");
    }

    /// Generate the same samples used for visual and Unicode extraction checks.
    #[test]
    #[ignore]
    fn adaptive_pdf_visual_samples() {
        let directory = PathBuf::from(env::var("CARPO_PDF_QA_DIR").expect("set CARPO_PDF_QA_DIR"));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("source.jpg"), source_image().jpeg).unwrap();
        let normal = sample_part();
        let mut dense = normal.clone();
        dense.document.pages[0].index = 8;
        dense.source_images.insert(8, source_image());
        dense.document.pages[0].blocks[1].text =
            "密集正文，用于检查自动续页与中文可复制性。".repeat(500) + "正文结束标记";
        let mut article = normal.clone();
        article.document.pages.clear();
        article.source_images.clear();
        article.articles = vec![PdfArticle {
            title: "跨页报道".into(),
            body: "报道正文，完整保留跨框与跨页内容。".repeat(260) + "报道结束标记",
            images: vec![source_image(); 4],
        }];
        let mut long_table = normal.clone();
        long_table.document.pages[0].blocks = vec![block(
            "table",
            &format!(
                "<table><tr><th>项目</th><th>内容</th></tr>{}</table>",
                (0..140)
                    .map(|i| format!(
                        "<tr><td>行{i}</td><td>长表格内容，逐行检查，不能丢失。</td></tr>"
                    ))
                    .collect::<String>()
            ),
            [60.0, 160.0, 940.0, 900.0],
            Some(1),
        )];
        for (name, parts, compared) in [
            ("normal", vec![normal.clone()], false),
            ("dense", vec![dense.clone()], false),
            ("long-table", vec![long_table], false),
            ("article-compare", vec![article.clone()], true),
            ("mixed-compare", vec![normal, dense, article], true),
        ] {
            let result = export_layout_pdf_to_path(LayoutPdfExportRequest {
                document: doc(Vec::new()),
                target_path: directory
                    .join(format!("{name}.pdf"))
                    .to_string_lossy()
                    .into(),
                options: LayoutPdfExportOptions {
                    include_images: true,
                    include_header: true,
                    include_footer: true,
                    include_aside_text: true,
                    with_source: compared,
                    parts,
                    ..Default::default()
                },
            })
            .unwrap();
            println!("{name}: {} pages, {:?}", result.page_count, result.warnings);
        }
    }
}
