//! Layout-document PDF exporter.
//!
//! This turns the normalized `LayoutDocument` produced by Paddle JSON import
//! into a rebuilt, selectable-text PDF. It intentionally does not put the
//! original scan underneath an invisible text layer: each block is drawn at
//! its Paddle bbox position, with tables/images represented by visible
//! placeholders in the first version.

use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::PathBuf,
};

use printpdf::{
    Color, FontId, FontMetrics, Mm, Op, PaintMode, ParsedFont, PdfDocument, PdfFontHandle, PdfPage,
    PdfSaveOptions, Point, Pt, Rect, Rgb, TextItem,
};
use serde::{Deserialize, Serialize};
use ttf_parser::Face;

use crate::{
    error::{AppError, AppResult},
    ocr::paddle_json::{LayoutBlock, LayoutDocument, LayoutPage},
};

const A4_PORTRAIT_W_PT: f32 = 595.28;
const A4_PORTRAIT_H_PT: f32 = 841.89;
const PAGE_MARGIN_PT: f32 = 18.0;
const BLOCK_PADDING_PT: f32 = 2.5;
const MIN_FONT_PT: f32 = 5.5;
const LINE_HEIGHT: f32 = 1.18;
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
    pub page_count: u32,
    pub warning_count: u32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LayoutPdfExportMode {
    #[default]
    Bbox,
    Reading,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutPdfExportOptions {
    #[serde(default)]
    pub mode: LayoutPdfExportMode,
    #[serde(default = "default_true")]
    pub include_header: bool,
    #[serde(default = "default_true")]
    pub include_footer: bool,
    #[serde(default = "default_true")]
    pub include_page_number: bool,
    #[serde(default = "default_true")]
    pub include_aside_text: bool,
    #[serde(default = "default_true")]
    pub include_footnote: bool,
    /// First version does not embed image assets. When true, image blocks are
    /// still placeholders, but the result warning tells the user why.
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
            mode: LayoutPdfExportMode::Bbox,
            include_header: true,
            include_footer: true,
            include_page_number: true,
            include_aside_text: true,
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

#[derive(Debug, Clone, Copy)]
struct PageMetrics {
    width_pt: f32,
    height_pt: f32,
    margin_pt: f32,
    scale: f32,
}

#[derive(Debug, Clone, Copy)]
struct PdfRect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

struct TextBlockRender<'a> {
    page_index: u32,
    label: &'a str,
    text: &'a str,
    rect: PdfRect,
    font_id: &'a FontId,
    options: &'a LayoutPdfExportOptions,
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

pub fn export_layout_pdf_to_path(req: LayoutPdfExportRequest) -> AppResult<LayoutPdfExportResult> {
    if req.target_path.trim().is_empty() {
        return Err(AppError::Config("缺少导出路径".into()));
    }
    if req.document.pages.is_empty() {
        return Err(AppError::Config("没有可导出的版式页面".into()));
    }

    let target_path = PathBuf::from(&req.target_path);
    if let Some(parent) = target_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AppError::FileNotFound(parent.display().to_string()));
        }
    }

    let mut warnings = Vec::new();
    if req.options.mode != LayoutPdfExportMode::Bbox {
        warnings.push("reading 模式尚未实现，已按 bbox 近似版式导出".to_string());
    }
    if req.options.include_images {
        warnings.push("图片嵌入尚未实现，图片区块已用占位框表示".to_string());
    }

    let chars = collect_required_chars(&req.document, &req.options);
    let loaded_font = load_cjk_font(&chars)?;
    if !loaded_font.missing_chars.is_empty() {
        let preview: String = loaded_font.missing_chars.iter().take(12).collect();
        warnings.push(format!(
            "字体 {} 缺少 {} 个字符（{}{}），缺字会显示为空白或替代字形",
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

    let mut doc = PdfDocument::new("Xcvt layout export");
    let font_id = doc.add_font(&loaded_font.font);
    let pages = req
        .document
        .pages
        .iter()
        .map(|page| render_page(page, &font_id, &req.options, &mut warnings))
        .collect::<Vec<_>>();
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
    let returned = warnings.into_iter().take(MAX_RETURNED_WARNINGS).collect();
    Ok(LayoutPdfExportResult {
        target_path: target_path.display().to_string(),
        page_count,
        warning_count,
        warnings: returned,
    })
}

fn render_page(
    page: &LayoutPage,
    font_id: &FontId,
    options: &LayoutPdfExportOptions,
    warnings: &mut Vec<String>,
) -> PdfPage {
    let metrics = page_metrics(page, options);
    let mut ops = Vec::new();
    let mut blocks = page
        .blocks
        .iter()
        .filter(|block| should_render_block(block, options))
        .collect::<Vec<_>>();
    blocks.sort_by(|a, b| {
        a.order
            .unwrap_or(u32::MAX)
            .cmp(&b.order.unwrap_or(u32::MAX))
            .then_with(|| a.bbox[1].total_cmp(&b.bbox[1]))
            .then_with(|| a.bbox[0].total_cmp(&b.bbox[0]))
    });

    for block in blocks {
        let rect = map_bbox(block.bbox, metrics);
        let label = normalized_label(&block.label);
        let placeholder = placeholder_text(&label);
        if placeholder.is_some() {
            draw_placeholder(&mut ops, rect);
        }
        let text = export_text_for_block(block, placeholder);
        if text.trim().is_empty() {
            continue;
        }
        render_text_block(
            &mut ops,
            warnings,
            TextBlockRender {
                page_index: page.index,
                label: &block.label,
                text: &text,
                rect,
                font_id,
                options,
            },
        );
    }

    PdfPage::new(pt_to_mm(metrics.width_pt), pt_to_mm(metrics.height_pt), ops)
}

fn page_metrics(page: &LayoutPage, options: &LayoutPdfExportOptions) -> PageMetrics {
    let source_w = page.width.max(1.0) as f32;
    let source_h = page.height.max(1.0) as f32;
    let landscape = source_w > source_h;
    let (max_w, max_h) = if landscape {
        (A4_PORTRAIT_H_PT, A4_PORTRAIT_W_PT)
    } else {
        (A4_PORTRAIT_W_PT, A4_PORTRAIT_H_PT)
    };
    let margin_pt = PAGE_MARGIN_PT * options.margin_scale.clamp(0.0, 3.0);
    let available_w = (max_w - margin_pt * 2.0).max(72.0);
    let available_h = (max_h - margin_pt * 2.0).max(72.0);
    let scale = (available_w / source_w)
        .min(available_h / source_h)
        .max(0.01);
    PageMetrics {
        width_pt: source_w * scale + margin_pt * 2.0,
        height_pt: source_h * scale + margin_pt * 2.0,
        margin_pt,
        scale,
    }
}

fn map_bbox(bbox: [f64; 4], metrics: PageMetrics) -> PdfRect {
    let x0 = bbox[0].min(bbox[2]).max(0.0) as f32;
    let y0 = bbox[1].min(bbox[3]).max(0.0) as f32;
    let x1 = bbox[0].max(bbox[2]).max(0.0) as f32;
    let y1 = bbox[1].max(bbox[3]).max(0.0) as f32;
    let x = metrics.margin_pt + x0 * metrics.scale;
    let y = metrics.height_pt - metrics.margin_pt - y1 * metrics.scale;
    PdfRect {
        x,
        y,
        w: ((x1 - x0) * metrics.scale).max(1.0),
        h: ((y1 - y0) * metrics.scale).max(1.0),
    }
}

fn render_text_block(ops: &mut Vec<Op>, warnings: &mut Vec<String>, block: TextBlockRender<'_>) {
    let TextBlockRender {
        page_index,
        label,
        text,
        rect,
        font_id,
        options,
    } = block;
    let mut font_size = font_size_for(label, rect, options);
    let max_w = (rect.w - BLOCK_PADDING_PT * 2.0).max(font_size);
    let max_h = (rect.h - BLOCK_PADDING_PT * 2.0).max(font_size);
    let mut lines = wrap_text(text, max_w, font_size);
    let mut needed_h = lines.len() as f32 * font_size * LINE_HEIGHT;
    if needed_h > max_h && needed_h > 0.0 {
        let shrink = (max_h / needed_h * 0.95).clamp(0.35, 1.0);
        font_size = (font_size * shrink).max(MIN_FONT_PT);
        lines = wrap_text(text, max_w, font_size);
        needed_h = lines.len() as f32 * font_size * LINE_HEIGHT;
    }
    if needed_h > max_h + font_size {
        warnings.push(format!(
            "第 {} 页 {} 区块文本超过 bbox，高度 {:.1}pt / {:.1}pt，已继续写出未截断",
            page_index, label, needed_h, max_h
        ));
    }

    let color = color_for_label(label);
    ops.push(Op::StartTextSection);
    ops.push(Op::SetFillColor { col: color });
    ops.push(Op::SetFont {
        font: PdfFontHandle::External(font_id.clone()),
        size: Pt(font_size),
    });
    ops.push(Op::SetLineHeight {
        lh: Pt(font_size * LINE_HEIGHT),
    });
    ops.push(Op::SetTextCursor {
        pos: Point {
            x: Pt(rect.x + BLOCK_PADDING_PT),
            y: Pt(rect.y + rect.h - BLOCK_PADDING_PT - font_size),
        },
    });
    for (idx, line) in lines.iter().enumerate() {
        ops.push(Op::ShowText {
            items: vec![TextItem::Text(line.clone())],
        });
        if idx + 1 < lines.len() {
            ops.push(Op::AddLineBreak);
        }
    }
    ops.push(Op::EndTextSection);
}

fn draw_placeholder(ops: &mut Vec<Op>, rect: PdfRect) {
    ops.push(Op::SetOutlineColor {
        col: Color::Rgb(Rgb::new(0.62, 0.66, 0.7, None)),
    });
    ops.push(Op::SetOutlineThickness { pt: Pt(0.55) });
    ops.push(Op::DrawRectangle {
        rectangle: Rect {
            x: Pt(rect.x),
            y: Pt(rect.y),
            width: Pt(rect.w),
            height: Pt(rect.h),
            mode: Some(PaintMode::Stroke),
            winding_order: None,
        },
    });
}

fn font_size_for(label: &str, rect: PdfRect, options: &LayoutPdfExportOptions) -> f32 {
    let label = normalized_label(label);
    let base = if label == "doc_title" {
        15.0
    } else if label == "paragraph_title" || label == "title" {
        12.0
    } else if is_header_label(&label) || is_footer_label(&label) || is_page_number_label(&label) {
        7.0
    } else if is_aside_label(&label) || is_footnote_label(&label) {
        7.5
    } else if is_table_label(&label) {
        8.2
    } else {
        9.2
    };
    let scaled = base * options.font_scale.clamp(0.5, 2.0);
    scaled
        .min((rect.h * 0.65).max(MIN_FONT_PT))
        .max(MIN_FONT_PT)
}

fn color_for_label(label: &str) -> Color {
    let label = normalized_label(label);
    if is_header_label(&label) || is_footer_label(&label) || is_page_number_label(&label) {
        Color::Rgb(Rgb::new(0.45, 0.47, 0.5, None))
    } else if is_image_label(&label) || is_table_label(&label) {
        Color::Rgb(Rgb::new(0.32, 0.35, 0.38, None))
    } else {
        Color::Rgb(Rgb::new(0.08, 0.08, 0.09, None))
    }
}

fn wrap_text(text: &str, max_width_pt: f32, font_size_pt: f32) -> Vec<String> {
    let mut out = Vec::new();
    for paragraph in text.replace("\r\n", "\n").split('\n') {
        if paragraph.trim().is_empty() {
            if !out.last().is_some_and(String::is_empty) {
                out.push(String::new());
            }
            continue;
        }
        let mut line = String::new();
        let mut width = 0.0_f32;
        for ch in paragraph.chars() {
            let ch_width = estimated_char_width(ch) * font_size_pt;
            if !line.is_empty() && width + ch_width > max_width_pt {
                out.push(line);
                line = String::new();
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

fn estimated_char_width(ch: char) -> f32 {
    if ch.is_ascii_whitespace() {
        0.35
    } else if ch.is_ascii() {
        0.55
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

fn should_render_block(block: &LayoutBlock, options: &LayoutPdfExportOptions) -> bool {
    let label = normalized_label(&block.label);
    if is_header_label(&label) && !options.include_header {
        return false;
    }
    if is_footer_label(&label) && !options.include_footer {
        return false;
    }
    if is_page_number_label(&label) && !options.include_page_number {
        return false;
    }
    if is_aside_label(&label) && !options.include_aside_text {
        return false;
    }
    if is_footnote_label(&label) && !options.include_footnote {
        return false;
    }
    if is_table_label(&label) && !options.include_tables {
        return false;
    }
    true
}

fn export_text_for_block(block: &LayoutBlock, placeholder: Option<&'static str>) -> String {
    let trimmed = block.text.trim();
    match placeholder {
        Some(prefix) if trimmed.is_empty() => prefix.to_string(),
        Some(prefix) => format!("{prefix}\n{trimmed}"),
        None => {
            if should_approximate_vertical_title(block) {
                trimmed
                    .chars()
                    .map(|c| c.to_string())
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                trimmed.to_string()
            }
        }
    }
}

fn should_approximate_vertical_title(block: &LayoutBlock) -> bool {
    let label = normalized_label(&block.label);
    if label != "doc_title" && label != "paragraph_title" && label != "title" {
        return false;
    }
    let w = (block.bbox[2] - block.bbox[0]).abs();
    let h = (block.bbox[3] - block.bbox[1]).abs();
    h > w * 1.8 && block.text.chars().count() <= 30
}

fn placeholder_text(label: &str) -> Option<&'static str> {
    if is_image_label(label) {
        Some("[图片占位]")
    } else if is_table_label(label) {
        Some("[表格]")
    } else {
        None
    }
}

fn normalized_label(label: &str) -> String {
    label.trim().to_ascii_lowercase()
}

fn is_header_label(label: &str) -> bool {
    label == "header" || label == "doc_header"
}

fn is_footer_label(label: &str) -> bool {
    label == "footer" || label == "doc_footer"
}

fn is_page_number_label(label: &str) -> bool {
    matches!(label, "number" | "page_number" | "page_no" | "page_num")
}

fn is_aside_label(label: &str) -> bool {
    label == "aside_text" || label == "aside"
}

fn is_footnote_label(label: &str) -> bool {
    label.contains("footnote")
}

fn is_table_label(label: &str) -> bool {
    label.contains("table")
}

fn is_image_label(label: &str) -> bool {
    label.contains("image") || label == "figure"
}

fn collect_required_chars(
    document: &LayoutDocument,
    options: &LayoutPdfExportOptions,
) -> BTreeSet<char> {
    let mut chars: BTreeSet<char> = "Xcvt版式导出图片占位表格".chars().collect();
    for page in &document.pages {
        for block in &page.blocks {
            if !should_render_block(block, options) {
                continue;
            }
            let label = normalized_label(&block.label);
            let text = export_text_for_block(block, placeholder_text(&label));
            chars.extend(text.chars().filter(|c| !c.is_control()));
        }
    }
    chars
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
        "未找到可用中文字体；请安装 Noto Sans CJK、Arial Unicode、微软雅黑或宋体后重试".into(),
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

    fn block(label: &str, text: &str, bbox: [f64; 4]) -> LayoutBlock {
        LayoutBlock {
            label: label.into(),
            text: text.into(),
            bbox,
            polygon: None,
            order: None,
            image_ref: None,
        }
    }

    #[test]
    fn map_bbox_converts_top_left_to_pdf_bottom_left() {
        let metrics = PageMetrics {
            width_pt: 220.0,
            height_pt: 320.0,
            margin_pt: 10.0,
            scale: 0.1,
        };
        let rect = map_bbox([100.0, 200.0, 300.0, 500.0], metrics);
        assert!((rect.x - 20.0).abs() < 0.001);
        assert!((rect.y - 260.0).abs() < 0.001);
        assert!((rect.w - 20.0).abs() < 0.001);
        assert!((rect.h - 30.0).abs() < 0.001);
    }

    #[test]
    fn block_filter_respects_header_footer_options() {
        let mut opts = LayoutPdfExportOptions::default();
        opts.include_header = false;
        opts.include_footer = false;
        opts.include_page_number = false;
        assert!(!should_render_block(
            &block("header", "h", [0.0, 0.0, 1.0, 1.0]),
            &opts
        ));
        assert!(!should_render_block(
            &block("footer", "f", [0.0, 0.0, 1.0, 1.0]),
            &opts
        ));
        assert!(!should_render_block(
            &block("number", "1", [0.0, 0.0, 1.0, 1.0]),
            &opts
        ));
        assert!(should_render_block(
            &block("text", "body", [0.0, 0.0, 1.0, 1.0]),
            &opts
        ));
    }

    #[test]
    fn wrap_text_breaks_full_width_text_by_estimated_width() {
        let lines = wrap_text("中文中文中文", 20.0, 10.0);
        assert_eq!(lines, vec!["中文", "中文", "中文"]);
    }

    #[test]
    fn image_and_table_blocks_get_visible_placeholders() {
        assert_eq!(placeholder_text("image"), Some("[图片占位]"));
        assert_eq!(placeholder_text("table"), Some("[表格]"));
        assert_eq!(placeholder_text("text"), None);
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn exports_selectable_text_pdf_with_system_cjk_font() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("layout.pdf");
        let req = LayoutPdfExportRequest {
            document: LayoutDocument {
                source: "paddle".into(),
                pages: vec![LayoutPage {
                    index: 1,
                    width: 1000.0,
                    height: 1400.0,
                    blocks: vec![block("text", "中文正文 ABC", [80.0, 120.0, 600.0, 260.0])],
                }],
            },
            target_path: target.display().to_string(),
            options: LayoutPdfExportOptions::default(),
        };
        let result = export_layout_pdf_to_path(req).unwrap();
        assert_eq!(result.page_count, 1);
        let bytes = std::fs::read(target).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
    }
}
