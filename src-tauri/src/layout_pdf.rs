//! Reading-version exporter for the normalized `LayoutDocument`.
//!
//! Earlier versions tried to *reconstruct the original page* by drawing every
//! Paddle block at its bbox position. For research use that was the wrong
//! target: the pruned web-export JSON only carries block-level boxes and a
//! concatenated `block_content`, so a faithful facsimile is impossible and
//! vertical books came out unreadable.
//!
//! Instead this module produces a **clean, reflowed reading version**:
//! - Blocks are emitted in reading order (`block_order`), flowing across as
//!   many A4 pages as the text needs.
//! - Page furniture (running headers/footers, bare page numbers, side notes)
//!   is filtered out; the source page index is kept as a stable anchor so
//!   passages stay citeable even when OCR page-number blocks are wrong.
//! - Vertical text needs no special handling: Paddle's `block_content` is
//!   already a horizontal reading-order string.
//! - Headings are re-styled from the block *label*, so stray Markdown markers
//!   (`#`, `####`) never leak into the output.
//!
//! Two outputs share the same block processing: a reflowed PDF
//! ([`export_layout_pdf_to_path`]) and a Markdown file
//! ([`export_reading_markdown_to_path`]).

use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs, mem,
    path::PathBuf,
};

use printpdf::{
    Color, FontId, FontMetrics, Mm, Op, ParsedFont, PdfDocument, PdfFontHandle, PdfPage,
    PdfSaveOptions, Point, Pt, Rgb, TextItem,
};
use serde::{Deserialize, Serialize};
use ttf_parser::Face;

use xcvt_core::{
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

/// Retained for wire compatibility with the frontend request type. The reading
/// exporter no longer has a bbox mode; the field is accepted and ignored.
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
    /// Image embedding is not implemented yet: image blocks always render as a
    /// visible placeholder so the reader knows a figure sat there.
    #[serde(default)]
    pub include_images: bool,
    #[serde(default = "default_true")]
    pub include_tables: bool,
    #[serde(default = "default_scale")]
    pub font_scale: f32,
    #[serde(default = "default_scale")]
    pub margin_scale: f32,
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
    xcvt_core::trf!("源文件第 {} 页", "Source page {}", page.index)
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
                        xcvt_core::tr!("［表格］", "[table]").to_string()
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
        if !page_items.is_empty() {
            if options.include_page_number {
                items.push(ReadingItem {
                    role: BlockRole::PageNumber,
                    text: None,
                    anchor: Some(page_anchor_label(page)),
                });
            }
            items.extend(page_items);
        }
    }
    if image_notice {
        if options.include_images {
            warnings.push(
                xcvt_core::tr!(
                    "图片内嵌尚未实现，图片区块已用占位说明表示",
                    "Embedding images is not implemented yet — image blocks are shown as placeholders"
                )
                .to_string(),
            );
        } else {
            warnings.push(
                xcvt_core::tr!(
                    "图片区块未嵌入，已用占位说明表示",
                    "Image blocks were not embedded — they are shown as placeholders"
                )
                .to_string(),
            );
        }
    }
    if empty_table_notice {
        warnings.push(
            xcvt_core::tr!(
                "部分表格无文本内容，已用占位说明表示",
                "Some tables carry no text — they are shown as placeholders"
            )
            .to_string(),
        );
    }
    if inferred_furniture_count > 0 {
        warnings.push(xcvt_core::trf!(
            "已过滤 {} 个重复页眉/页脚块",
            "Filtered out {} repeated header/footer blocks",
            inferred_furniture_count
        ));
    }
    if scanner_artifact_count > 0 {
        warnings.push(xcvt_core::trf!(
            "已过滤 {} 个扫描/封装元数据块",
            "Filtered out {} scanner / container metadata blocks",
            scanner_artifact_count
        ));
    }
    items
}

fn image_placeholder(image_ref: Option<&str>) -> String {
    match image_ref.and_then(display_image_ref) {
        Some(source) => {
            xcvt_core::trf!("［图片：未嵌入：{}］", "[image: not embedded: {}]", source)
        }
        None => xcvt_core::tr!("［图片：未嵌入］", "[image: not embedded]").to_string(),
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
    let target_path = validate_target(&req.target_path, &req.document)?;
    let mut warnings = Vec::new();
    if req.options.mode == LayoutPdfExportMode::Bbox {
        warnings.push(
            xcvt_core::tr!(
                "bbox 版式重建已改为阅读版导出",
                "bbox layout reconstruction now exports the reading view instead"
            )
            .to_string(),
        );
    }
    let items = build_reading_items(&req.document, &req.options, &mut warnings);

    let chars = collect_item_chars(&items);
    let loaded_font = load_cjk_font(&chars)?;
    push_missing_char_warning(&loaded_font, &mut warnings);

    let mut doc = PdfDocument::new("Xcvt reading export");
    let font_id = doc.add_font(&loaded_font.font);
    let font_scale = req.options.font_scale.clamp(0.5, 2.0);
    let margin_scale = req.options.margin_scale.clamp(0.5, 2.0);

    let mut flow = Flow::new(&font_id, margin_scale);
    for item in &items {
        match (&item.text, &item.anchor) {
            (None, Some(label)) => flow.emit_anchor(label, font_scale),
            (Some(text), _) => flow.emit_block(item.role, text, font_scale),
            _ => {}
        }
    }
    let pages_ops = flow.finish();
    let page_count = pages_ops.len() as u32;
    let pages: Vec<PdfPage> = pages_ops
        .into_iter()
        .map(|ops| PdfPage::new(pt_to_mm(A4_W_PT), pt_to_mm(A4_H_PT), ops))
        .collect();
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
    margin_x: f32,
    margin_top: f32,
    margin_bottom: f32,
    pages: Vec<Vec<Op>>,
    cur: Vec<Op>,
    y: f32,
    started: bool,
}

impl<'a> Flow<'a> {
    fn new(font_id: &'a FontId, margin_scale: f32) -> Self {
        let margin_x = MARGIN_X_PT * margin_scale;
        let margin_top = MARGIN_TOP_PT * margin_scale;
        let margin_bottom = MARGIN_BOTTOM_PT * margin_scale;
        Flow {
            font_id,
            margin_x,
            margin_top,
            margin_bottom,
            pages: Vec::new(),
            cur: Vec::new(),
            y: A4_H_PT - margin_top,
            started: false,
        }
    }

    fn content_width(&self) -> f32 {
        (A4_W_PT - self.margin_x * 2.0).max(72.0)
    }

    fn new_page(&mut self) {
        self.pages.push(mem::take(&mut self.cur));
        self.y = A4_H_PT - self.margin_top;
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
        if self.started && self.y < A4_H_PT - self.margin_top - 0.01 {
            self.y -= style.gap_before;
        }
        let first_width = (self.content_width() - style.indent).max(style.size);
        let font_id = self.font_id;
        // Wrap the first line against the indented width, the rest full width.
        let lines = wrap_paragraph(text, self.content_width(), first_width, style.size);
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

/// Wrap a paragraph where the first visual line has `first_width` available
/// (to leave room for an indent) and subsequent lines have `full_width`.
fn wrap_paragraph(text: &str, full_width: f32, first_width: f32, font_size: f32) -> Vec<String> {
    let mut out = Vec::new();
    for source_line in text.split('\n') {
        if source_line.trim().is_empty() {
            continue;
        }
        let mut line = String::new();
        let mut width = 0.0_f32;
        for ch in source_line.chars() {
            let limit = if out.is_empty() {
                first_width
            } else {
                full_width
            };
            let ch_width = estimated_char_width(ch) * font_size;
            if !line.is_empty() && width + ch_width > limit {
                out.push(mem::take(&mut line));
                width = 0.0;
            }
            line.push(ch);
            width += ch_width;
        }
        if !line.is_empty() {
            out.push(line);
        }
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
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
        "tr" => {
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
        "td" | "th" => {
            if !out.ends_with('|') && !out.ends_with('\n') {
                out.push('|');
            }
        }
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
            xcvt_core::tr!(
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
            xcvt_core::tr!("缺少导出路径", "No export path given").into(),
        ));
    }
    if document.pages.is_empty() {
        return Err(AppError::Config(
            xcvt_core::tr!(
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
    let mut chars: BTreeSet<char> = xcvt_core::tr!(
        "Xcvt源文件第页〔〕［］图表格未嵌入",
        "Xcvt[]:Source page image table not embedded"
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
    warnings.push(xcvt_core::trf!(
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
        xcvt_core::tr!(
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
    if let Some(path) = env::var_os("XCVT_LAYOUT_PDF_FONT") {
        out.insert(
            0,
            FontCandidate {
                path: PathBuf::from(path),
                index: env::var("XCVT_LAYOUT_PDF_FONT_INDEX")
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
    fn classifies_labels_into_roles() {
        assert_eq!(classify("doc_title"), BlockRole::DocTitle);
        assert_eq!(classify("paragraph_title"), BlockRole::Heading);
        assert_eq!(classify("vertical_text"), BlockRole::Body);
        assert_eq!(classify("text"), BlockRole::Body);
        assert_eq!(classify("number"), BlockRole::PageNumber);
        assert_eq!(classify("header"), BlockRole::Header);
        assert_eq!(classify("vision_footnote"), BlockRole::Footnote);
        assert_eq!(classify("table"), BlockRole::Table);
        assert_eq!(classify("image"), BlockRole::Image);
    }

    #[test]
    fn clean_block_text_strips_heading_markers() {
        assert_eq!(clean_block_text("#### 颜序"), "颜序");
        assert_eq!(clean_block_text("# 新聞學"), "新聞學");
        assert_eq!(clean_block_text("**重点**"), "重点");
        assert_eq!(clean_block_text("正文无标记"), "正文无标记");
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
    fn html_table_is_simplified_for_pdf_text() {
        let html = "<table><tr><td>A&nbsp;1</td><td>B&amp;2</td></tr><tr><td>C</td><td>D</td></tr></table>";
        assert_eq!(
            pdf_text_for_role(BlockRole::Table, html),
            "A 1 | B&2\nC | D"
        );
        assert_eq!(pdf_text_for_role(BlockRole::Body, html), html);
    }

    #[test]
    fn image_placeholder_keeps_short_reference() {
        assert_eq!(
            image_placeholder(Some("imgs/img_in_image_box_309_947_971_1272.jpg")),
            "［图片：未嵌入：imgs/img_in_image_box_309_947_971_1272.jpg］"
        );
        assert_eq!(
            image_placeholder(Some(
                "https://example.test/assets/input_img_0.jpg?authorization=secret"
            )),
            "［图片：未嵌入：input_img_0.jpg］"
        );
        assert_eq!(image_placeholder(None), "［图片：未嵌入］");
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
    fn scanner_artifact_blocks_are_dropped_without_empty_anchor() {
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
            },
            LayoutPage {
                index: 2,
                width: 1000.0,
                height: 1500.0,
                blocks: vec![block("text", "正文", [50.0, 100.0, 950.0, 500.0], Some(1))],
            },
        ]);
        let mut warnings = Vec::new();
        let items = build_reading_items(&d, &LayoutPdfExportOptions::default(), &mut warnings);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].anchor.as_deref(), Some("源文件第 2 页"));
        assert_eq!(items[1].text.as_deref(), Some("正文"));
        assert!(warnings.iter().any(|w| w.contains("扫描/封装元数据")));
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
        };
        assert_eq!(page_anchor_label(&page), "源文件第 1 页");

        let page = LayoutPage {
            index: 3,
            width: 1000.0,
            height: 1500.0,
            blocks: vec![block("number", "11", [0.0, 0.0, 10.0, 10.0], None)],
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
        }]);
        let mut warnings = Vec::new();
        let items = build_reading_items(&d, &opts, &mut warnings);
        let texts: Vec<_> = items.iter().filter_map(|i| i.text.as_deref()).collect();
        assert_eq!(texts, vec!["邵飘萍", "［图片：未嵌入］"]);
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn exports_multi_page_reading_pdf() {
        // A big block so the reflow spills onto multiple A4 pages.
        let long = "中文正文测试。".repeat(2000);
        let d = doc(vec![LayoutPage {
            index: 1,
            width: 1000.0,
            height: 1500.0,
            blocks: vec![block("text", &long, [80.0, 120.0, 900.0, 1400.0], Some(1))],
        }]);
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("reading.pdf");
        let req = LayoutPdfExportRequest {
            document: d,
            target_path: target.display().to_string(),
            options: LayoutPdfExportOptions::default(),
        };
        let result = export_layout_pdf_to_path(req).unwrap();
        assert!(result.page_count > 1, "expected reflow across pages");
        let bytes = std::fs::read(target).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
    }

    /// Manual end-to-end check against a real Paddle JSON export. Run with:
    /// `XCVT_SAMPLE_JSON=/path/book.json cargo test --manifest-path src-tauri/Cargo.toml
    ///  reading_export_from_real_json -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn reading_export_from_real_json() {
        let json_path = std::env::var("XCVT_SAMPLE_JSON").expect("set XCVT_SAMPLE_JSON");
        let import = xcvt_core::ocr::paddle_json::analyze_path(std::path::Path::new(&json_path))
            .expect("analyze json");
        let stem = std::path::Path::new(&json_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("sample")
            .to_string();
        let out_dir = std::env::var("XCVT_OUT_DIR").unwrap_or_else(|_| "/tmp".into());
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
}
