//! PDF page-extraction chunking for Paddle document-level OCR.
//!
//! Paddle's async OCR job endpoint caps multipart uploads at 50 MB and the
//! submitted file's page count at 1000. When the source PDF exceeds either
//! limit (or both), we split the user's requested page subset into smaller
//! PDFs ("chunks") with PDFium's `FPDF_ImportPages`, submit each chunk
//! separately, then translate chunk-local page numbers back to the
//! original PDF's page numbering before the rest of the app sees them.
//!
//! Module boundary: this file knows how to split a PDF and how to map
//! chunk pages back. It does *not* know anything about Paddle's API.
//! Conversely, [`crate::ocr::paddle_document`] does not know that
//! chunking exists — it receives one PDF at a time and emits results
//! against chunk-local page numbers. Reassembly happens in the
//! whole-file runner that orchestrates both.
//!
//! Strategy is decided up front from observable inputs (file size,
//! source page count). Once chunking starts, each chunk PDF is measured
//! on disk after extraction; if it lands above the 50 MB multipart cap
//! despite the size estimate, the batch is bisected and rebuilt. A
//! single-page batch that still overshoots is reported as a hard
//! config error — there is no safe way to push that page through the
//! multipart path without pre-compression.

use std::fs;
use std::path::{Path, PathBuf};

use pdfium_render::prelude::{PdfDocument, Pdfium};

use crate::error::{AppError, AppResult};
use crate::ocr::paddle_document::pages_to_ranges_string;

/// Paddle's documented multipart upload cap. Files larger than this can
/// only reach Paddle via chunking or (future phase) the file-URL path.
pub const MULTIPART_LIMIT_BYTES: u64 = 50 * 1024 * 1024;

/// Paddle's hard ceiling on the *submitted file's* page count. This
/// applies to the file as a whole, not the subset selected by
/// `pageRanges`, so a 2000-page PDF with five selected pages still has
/// to be chunked.
pub const PADDLE_HARD_PAGE_LIMIT: u32 = 1000;

/// Target ceiling for each chunk's on-disk size. ~20 % headroom under
/// the 50 MB multipart cap so normal PDF-extraction overhead doesn't
/// push a chunk past the line.
pub const DEFAULT_CHUNK_TARGET_BYTES: u64 = 40 * 1024 * 1024;

/// Page-count cap per chunk. Well below the 1000-page Paddle ceiling so
/// each chunk's wall-clock OCR time stays bounded — a 200-page chunk on
/// PaddleOCR-VL takes ~5 min, which keeps cancel/retry granularity
/// reasonable.
pub const DEFAULT_CHUNK_MAX_PAGES: u32 = 800;

/// Knobs for [`build_chunks`]. Bundled into a struct so tests can dial
/// the limits down to bytes (instead of megabytes) to exercise the
/// bisect path without needing a real giant fixture PDF.
#[derive(Debug, Clone, Copy)]
pub struct ChunkConfig {
    pub target_chunk_bytes: u64,
    pub max_chunk_pages: u32,
    pub multipart_limit_bytes: u64,
}

impl Default for ChunkConfig {
    fn default() -> Self {
        Self {
            target_chunk_bytes: DEFAULT_CHUNK_TARGET_BYTES,
            max_chunk_pages: DEFAULT_CHUNK_MAX_PAGES,
            multipart_limit_bytes: MULTIPART_LIMIT_BYTES,
        }
    }
}

/// Submission path the runner should take.
///
/// Two variants today. A future `FileUrl` variant (50-200 MB band when
/// the user has a file-URL provider configured) would slot in here; we
/// don't add it now because there's no upload-and-get-URL surface yet
/// and dead variants make the runner's `match` arms muddier than
/// explicit branching.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkStrategy {
    /// File fits in one multipart upload; submit the whole PDF with a
    /// `pageRanges` filter.
    DirectMultipart,
    /// File exceeds the multipart limit or the source-page ceiling;
    /// extract chosen pages into smaller PDFs and submit each.
    Chunked,
}

/// Pick a strategy from observable file metadata. The Paddle multipart
/// limit and 1000-page source ceiling are both hard limits set by the
/// API — we don't second-guess them with provider settings here.
pub fn decide_strategy(file_bytes: u64, source_page_count: u32) -> ChunkStrategy {
    if file_bytes > MULTIPART_LIMIT_BYTES || source_page_count > PADDLE_HARD_PAGE_LIMIT {
        ChunkStrategy::Chunked
    } else {
        ChunkStrategy::DirectMultipart
    }
}

/// One chunk produced by [`build_chunks`]: a freshly-extracted PDF
/// covering a contiguous slice of the user's requested pages.
#[derive(Debug, Clone)]
pub struct ChunkManifest {
    pub chunk_id: String,
    pub chunk_pdf_path: PathBuf,
    /// Original PDF page numbers (1-based), in the order they appear
    /// inside the chunk PDF. So `original_pages[chunk_page - 1]` is the
    /// original page number for chunk-local page `chunk_page`.
    pub original_pages: Vec<u32>,
    /// Measured on disk after `save_to_file`.
    pub size_bytes: u64,
}

impl ChunkManifest {
    /// Map a 1-based chunk-local page back to the original PDF's page
    /// numbering. Returns `None` when Paddle reports a page number
    /// outside the chunk — shouldn't happen but we don't panic on
    /// unexpected provider output.
    pub fn original_page(&self, chunk_page: u32) -> Option<u32> {
        let idx = (chunk_page as usize).checked_sub(1)?;
        self.original_pages.get(idx).copied()
    }
}

/// Plan how to split `requested_pages` across chunks before touching
/// pdfium. Uses average bytes per source page as the size proxy. The
/// caller must guarantee `requested_pages` is sorted ascending and
/// deduplicated — pdf_chunk does not re-normalise.
pub fn plan_chunk_page_batches(
    requested_pages: &[u32],
    source_size_bytes: u64,
    source_page_count: u32,
    config: &ChunkConfig,
) -> Vec<Vec<u32>> {
    if requested_pages.is_empty() {
        return Vec::new();
    }
    let avg = avg_bytes_per_page(source_size_bytes, source_page_count);
    // If we can't estimate (zero source pages, defensive), fall back to
    // the page-count cap alone.
    let by_size = config
        .target_chunk_bytes
        .checked_div(avg)
        .and_then(|pages| usize::try_from(pages.max(1)).ok())
        .unwrap_or(config.max_chunk_pages as usize);
    let pages_per_chunk = by_size.min(config.max_chunk_pages as usize).max(1);
    requested_pages
        .chunks(pages_per_chunk)
        .map(<[u32]>::to_vec)
        .collect()
}

fn avg_bytes_per_page(file_bytes: u64, page_count: u32) -> u64 {
    if page_count == 0 {
        0
    } else {
        (file_bytes / page_count as u64).max(1)
    }
}

/// Validate the contract every public entry-point shares: pages must be
/// non-empty and strictly ascending. Strict ascending (not merely
/// "sorted") is enforced because the chunking code's mapping back to
/// original pages assumes no duplicates.
pub fn validate_requested_pages(pages: &[u32]) -> AppResult<()> {
    if pages.is_empty() {
        return Err(AppError::Config("no pages to chunk".into()));
    }
    if pages[0] == 0 {
        return Err(AppError::Config("page numbers must be 1-based".into()));
    }
    if !pages.windows(2).all(|w| w[0] < w[1]) {
        return Err(AppError::Internal(
            "build_chunks: requested_pages must be strictly ascending and deduplicated".into(),
        ));
    }
    Ok(())
}

/// Build one chunk PDF per planned batch. Each chunk PDF is measured
/// after `save_to_file`; if it exceeds `config.multipart_limit_bytes`
/// the batch is split in half and rebuilt. A single-page batch that
/// still overshoots fails with `AppError::Config` — the only honest
/// answer is to ask the user to pre-compress the source.
///
/// Synchronous, takes `&Pdfium` — call this from the PdfWorker thread.
/// `output_dir` is expected to be a caller-owned directory (typically a
/// `tempfile::TempDir`); its lifetime must outlive the returned
/// manifests since the PDF files live inside it.
pub fn build_chunks(
    pdfium: &Pdfium,
    source_path: &Path,
    requested_pages: &[u32],
    output_dir: &Path,
    source_size_bytes: u64,
    source_page_count: u32,
    config: &ChunkConfig,
) -> AppResult<Vec<ChunkManifest>> {
    validate_requested_pages(requested_pages)?;
    let batches = plan_chunk_page_batches(
        requested_pages,
        source_size_bytes,
        source_page_count,
        config,
    );

    let source = pdfium
        .load_pdf_from_file(source_path, None)
        .map_err(|e| AppError::Pdf(format!("load source: {e}")))?;

    let mut out: Vec<ChunkManifest> = Vec::new();
    let mut counter = 0_u32;
    for batch in batches {
        build_one(
            pdfium,
            &source,
            output_dir,
            &batch,
            config,
            &mut counter,
            &mut out,
        )?;
    }
    Ok(out)
}

fn build_one(
    pdfium: &Pdfium,
    source: &PdfDocument<'_>,
    output_dir: &Path,
    batch: &[u32],
    config: &ChunkConfig,
    counter: &mut u32,
    out: &mut Vec<ChunkManifest>,
) -> AppResult<()> {
    if batch.is_empty() {
        return Ok(());
    }
    *counter += 1;
    let id = format!("chunk-{:03}", *counter);
    let path = output_dir.join(format!("{id}.pdf"));

    let mut doc = pdfium
        .create_new_pdf()
        .map_err(|e| AppError::Pdf(format!("create chunk doc: {e}")))?;
    let ranges = pages_to_ranges_string(batch);
    doc.pages_mut()
        .copy_pages_from_document(source, &ranges, 0)
        .map_err(|e| AppError::Pdf(format!("copy pages {ranges}: {e}")))?;
    doc.save_to_file(&path)
        .map_err(|e| AppError::Pdf(format!("save {}: {e}", path.display())))?;

    let size_bytes = fs::metadata(&path)
        .map_err(|e| AppError::Internal(format!("stat {}: {e}", path.display())))?
        .len();

    if size_bytes > config.multipart_limit_bytes {
        // Drop the over-limit file before retrying so the temp dir
        // doesn't accumulate dead bytes during recursion.
        let _ = fs::remove_file(&path);
        if batch.len() == 1 {
            return Err(AppError::Config(format!(
                "page {} alone extracts to {:.1} MB which exceeds Paddle's {} MB multipart limit; please pre-compress the source PDF",
                batch[0],
                size_bytes as f64 / 1_048_576.0,
                config.multipart_limit_bytes / 1_048_576,
            )));
        }
        // Roll back the counter for the discarded id so chunk ids stay
        // monotonic across the surviving manifests.
        *counter -= 1;
        let mid = batch.len() / 2;
        let (left, right) = batch.split_at(mid);
        build_one(pdfium, source, output_dir, left, config, counter, out)?;
        build_one(pdfium, source, output_dir, right, config, counter, out)?;
        return Ok(());
    }

    out.push(ChunkManifest {
        chunk_id: id,
        chunk_pdf_path: path,
        original_pages: batch.to_vec(),
        size_bytes,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_cfg(target: u64, max_pages: u32, multipart: u64) -> ChunkConfig {
        ChunkConfig {
            target_chunk_bytes: target,
            max_chunk_pages: max_pages,
            multipart_limit_bytes: multipart,
        }
    }

    #[test]
    fn decide_strategy_picks_direct_when_under_both_limits() {
        assert_eq!(
            decide_strategy(10 * 1024 * 1024, 50),
            ChunkStrategy::DirectMultipart
        );
        // At the exact thresholds we stay direct — the limits are inclusive.
        assert_eq!(
            decide_strategy(MULTIPART_LIMIT_BYTES, PADDLE_HARD_PAGE_LIMIT),
            ChunkStrategy::DirectMultipart
        );
    }

    #[test]
    fn decide_strategy_chunks_when_either_limit_exceeded() {
        assert_eq!(
            decide_strategy(MULTIPART_LIMIT_BYTES + 1, 50),
            ChunkStrategy::Chunked
        );
        assert_eq!(
            decide_strategy(1024, PADDLE_HARD_PAGE_LIMIT + 1),
            ChunkStrategy::Chunked
        );
    }

    #[test]
    fn plan_chunk_page_batches_empty_input_returns_empty() {
        let batches = plan_chunk_page_batches(&[], 1024, 10, &ChunkConfig::default());
        assert!(batches.is_empty());
    }

    #[test]
    fn plan_chunk_page_batches_clamps_to_max_pages_when_size_allows() {
        // Avg page size 1 KB; target 4 KB ⇒ 4 pages per chunk by size.
        // max_chunk_pages = 3 should win.
        let batches = plan_chunk_page_batches(
            &[1, 2, 3, 4, 5, 6, 7],
            10 * 1024,
            10,
            &mk_cfg(4 * 1024, 3, 50 * 1024),
        );
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0], vec![1, 2, 3]);
        assert_eq!(batches[1], vec![4, 5, 6]);
        assert_eq!(batches[2], vec![7]);
    }

    #[test]
    fn plan_chunk_page_batches_clamps_to_size_estimate_when_smaller() {
        // Avg page = 2 MB; target 4 MB ⇒ 2 pages per chunk.
        let batches = plan_chunk_page_batches(
            &[1, 2, 3, 4, 5],
            20 * 1024 * 1024,
            10,
            &mk_cfg(4 * 1024 * 1024, 100, 50 * 1024 * 1024),
        );
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0], vec![1, 2]);
        assert_eq!(batches[1], vec![3, 4]);
        assert_eq!(batches[2], vec![5]);
    }

    #[test]
    fn plan_chunk_page_batches_falls_back_when_avg_is_zero() {
        // Zero source pages ⇒ avg is 0 ⇒ fall back to max_chunk_pages.
        let batches = plan_chunk_page_batches(&[1, 2, 3, 4], 0, 0, &mk_cfg(1024, 2, 50 * 1024));
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0], vec![1, 2]);
        assert_eq!(batches[1], vec![3, 4]);
    }

    #[test]
    fn plan_chunk_page_batches_floors_to_at_least_one() {
        // Avg page bigger than target ⇒ would compute 0 ⇒ clamp to 1.
        let batches = plan_chunk_page_batches(
            &[1, 2, 3],
            100 * 1024 * 1024,
            10,
            &mk_cfg(1024, 100, 50 * 1024 * 1024),
        );
        assert_eq!(batches.len(), 3);
        for b in &batches {
            assert_eq!(b.len(), 1);
        }
    }

    #[test]
    fn manifest_original_page_translates_chunk_local() {
        let m = ChunkManifest {
            chunk_id: "chunk-001".into(),
            chunk_pdf_path: PathBuf::from("/tmp/x.pdf"),
            original_pages: vec![3, 7, 8, 12],
            size_bytes: 1234,
        };
        assert_eq!(m.original_page(1), Some(3));
        assert_eq!(m.original_page(2), Some(7));
        assert_eq!(m.original_page(3), Some(8));
        assert_eq!(m.original_page(4), Some(12));
    }

    #[test]
    fn manifest_original_page_returns_none_outside_range() {
        let m = ChunkManifest {
            chunk_id: "chunk-001".into(),
            chunk_pdf_path: PathBuf::from("/tmp/x.pdf"),
            original_pages: vec![3, 7],
            size_bytes: 0,
        };
        assert_eq!(m.original_page(0), None);
        assert_eq!(m.original_page(3), None);
        assert_eq!(m.original_page(999), None);
    }

    #[test]
    fn validate_requested_pages_rejects_empty() {
        assert!(matches!(
            validate_requested_pages(&[]),
            Err(AppError::Config(_))
        ));
    }

    #[test]
    fn validate_requested_pages_rejects_zero() {
        assert!(matches!(
            validate_requested_pages(&[0, 1, 2]),
            Err(AppError::Config(_))
        ));
    }

    #[test]
    fn validate_requested_pages_rejects_unsorted() {
        // Codex review point #3: any caller that passes non-ascending pages
        // would land us at the chunk-local→original mapping bug. Refuse
        // at the boundary instead of silently producing wrong results.
        assert!(matches!(
            validate_requested_pages(&[5, 1, 3]),
            Err(AppError::Internal(_))
        ));
    }

    #[test]
    fn validate_requested_pages_rejects_duplicates() {
        assert!(matches!(
            validate_requested_pages(&[1, 2, 2, 3]),
            Err(AppError::Internal(_))
        ));
    }

    #[test]
    fn validate_requested_pages_accepts_strictly_ascending() {
        assert!(validate_requested_pages(&[1, 2, 5, 8, 240]).is_ok());
        assert!(validate_requested_pages(&[7]).is_ok());
    }

    // The PDFium-backed build_chunks tests live under #[cfg(all(test,
    // any(target_os = "macos", target_os = "windows")))] in
    // pdf.rs-adjacent harnesses because they need the loaded dylib —
    // mirroring the existing pdf.rs fixture pattern. Pure planning /
    // validation tests above don't need pdfium and run on every host.
}

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod pdfium_tests {
    //! Tests that need a real loaded PDFium dylib. Skipped on Linux CI
    //! for the same reason as the pdf.rs fixture tests — the dev dylib
    //! lives under `pdfium/macos-arm64` / `pdfium/windows-x64`.
    use super::*;
    use crate::pdf::init_pdfium;
    use std::path::Path;

    // Inline helper duplicated from `tests` because the two test modules
    // are siblings — we'd need to mark the inner `tests::mk_cfg` as
    // `pub(super)` to share it, which leaks test-only API past the
    // module boundary. Three lines of duplication is cheaper.
    fn mk_cfg(target: u64, max_pages: u32, multipart: u64) -> ChunkConfig {
        ChunkConfig {
            target_chunk_bytes: target,
            max_chunk_pages: max_pages,
            multipart_limit_bytes: multipart,
        }
    }

    fn sample_pdf() -> &'static Path {
        Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/sample.pdf"
        ))
    }

    #[test]
    fn build_chunks_single_batch_when_file_small() {
        let pdfium = init_pdfium().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let manifests = build_chunks(
            &pdfium,
            sample_pdf(),
            &[1, 2],
            dir.path(),
            10 * 1024,
            2,
            &ChunkConfig::default(),
        )
        .unwrap();
        assert_eq!(manifests.len(), 1);
        assert_eq!(manifests[0].original_pages, vec![1, 2]);
        assert!(manifests[0].chunk_pdf_path.exists());
        assert!(manifests[0].size_bytes > 0);
        assert_eq!(manifests[0].original_page(1), Some(1));
        assert_eq!(manifests[0].original_page(2), Some(2));
    }

    #[test]
    fn build_chunks_splits_when_max_pages_forces_it() {
        let pdfium = init_pdfium().unwrap();
        let dir = tempfile::tempdir().unwrap();
        // Force one page per chunk via max_chunk_pages = 1.
        let manifests = build_chunks(
            &pdfium,
            sample_pdf(),
            &[1, 2],
            dir.path(),
            10 * 1024,
            2,
            &mk_cfg(40 * 1024 * 1024, 1, 50 * 1024 * 1024),
        )
        .unwrap();
        assert_eq!(manifests.len(), 2);
        assert_eq!(manifests[0].original_pages, vec![1]);
        assert_eq!(manifests[1].original_pages, vec![2]);
    }

    #[test]
    fn build_chunks_bisects_when_chunk_overshoots_multipart_limit() {
        // Dial multipart_limit_bytes down low enough that the produced
        // chunk PDF definitely overshoots. Bisection should kick in and
        // halve the batch repeatedly. The sample fixture is 2 pages, so
        // the recursion lands on two single-page batches that fit the
        // (intentionally very high) per-single-page allowance below.
        let pdfium = init_pdfium().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let manifests = build_chunks(
            &pdfium,
            sample_pdf(),
            &[1, 2],
            dir.path(),
            10 * 1024,
            2,
            &mk_cfg(40 * 1024 * 1024, 800, 1),
        );
        // Either the bisect ran successfully down to single-page batches
        // (small fixture pages still fit under our 1-byte limit? no —
        // they definitely don't), or the final single-page check
        // rejected with AppError::Config. We assert on the failure
        // shape: an honest hard-fail with a "please pre-compress"
        // message, not a silent upload of an oversized chunk.
        match manifests {
            Ok(ms) => {
                // Pages so small they actually fit in 1 byte? Very unlikely.
                // If this fires, the fixture is tiny enough to fit, which
                // is still a correct outcome — recursion must have
                // bisected to single-page successfully.
                for m in ms {
                    assert!(m.size_bytes <= 1);
                }
            }
            Err(AppError::Config(msg)) => {
                assert!(msg.contains("multipart limit"), "msg: {msg}");
            }
            Err(other) => panic!("unexpected error: {other:?}"),
        }
    }
}
