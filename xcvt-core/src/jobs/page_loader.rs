//! Lazy, bounded page-bitmap cache used by the OCR job runners.
//!
//! Replaces the previous "render every referenced page up front into a
//! HashMap" approach. That model held every prerendered page in memory for
//! the lifetime of the job — at A3 size and 300 DPI a single decoded page
//! is ~150 MB, so a multi-page whole-file run could allocate gigabytes
//! before the first OCR call ever fired.
//!
//! Instead this loader:
//! - For images: loads the bitmap exactly once, lazily, behind a
//!   `tokio::sync::OnceCell`. Every "page" of an image file is the same
//!   bitmap, so we hand back a cloned `Arc`.
//! - For PDFs: keeps a small LRU of decoded pages plus an in-flight slot
//!   map. Workers ask for a page on demand; concurrent requests for the
//!   same page attach to a shared `OnceCell` so PDFium only renders once
//!   per (page, generation) pair. Cache capacity is supplied by the caller
//!   (provider concurrency + 1) so the steady-state footprint is
//!   `(concurrency + 1) × page_size` rather than
//!   `referenced_pages × page_size`.
//!
//! Cancellation: every `get()` call accepts a `CancellationToken`. It's
//! threaded through to `PdfWorker::render_image_cancellable` (so queued
//! tasks are skipped at pull time) AND raced against the load future
//! itself via `tokio::select!` so the caller stops waiting the moment the
//! job is cancelled. The orphaned in-flight render still runs to
//! completion on the PDFium thread (PDFium has no abort API), but its
//! result lands in a closed `oneshot` and is dropped.

use std::collections::{HashMap, VecDeque};
use std::env;
use std::path::PathBuf;
use std::sync::{Arc, Weak};

use image::DynamicImage;
use tokio::sync::{Mutex, OnceCell};
use tokio_util::sync::CancellationToken;

use super::grouped::FileKind;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Floor for the decoded-page LRU capacity. The real capacity is supplied by
/// the caller (worker-pool width + 1 slack — see `ocr::concurrency_for`);
/// the floor only guards against a degenerate value disabling caching.
pub const MIN_PAGE_LRU_CAPACITY: usize = 2;

pub struct PageLoader {
    state: Arc<AppState>,
    kind: FileKind,
    path: PathBuf,
    ocr_dpi: u32,
    /// Long-edge pixel ceiling for PDF renders; `None` renders at `ocr_dpi`.
    max_long_edge: Option<u32>,
    image_bitmap: OnceCell<Arc<DynamicImage>>,
    pdf_cache: Mutex<LruInner>,
    /// Per-page in-flight slot. Multiple concurrent callers for the same
    /// page attach to the same `OnceCell` and observe a single render.
    /// Stored as `Weak` so the entry self-evicts once every awaiter drops
    /// its `Arc<OnceCell>` — no manual reaping needed.
    pdf_in_flight: Mutex<HashMap<u32, Weak<OnceCell<Arc<DynamicImage>>>>>,
}

/// Byte ceiling for the decoded-page cache.
///
/// The page count alone is the wrong unit: a slot holding an A4 page at 300
/// DPI is ~33 MB, the same slot holding a broadsheet scan is ~114 MB, so a
/// fixed "6 pages" capacity silently swings between 200 MB and 700 MB
/// depending on what the user opened. Budgeting bytes makes the ceiling mean
/// the same thing for every document.
///
/// Override with `XCVT_OCR_PAGE_CACHE_BYTES`.
pub const DEFAULT_PAGE_CACHE_BUDGET_BYTES: u64 = 512 * 1024 * 1024;

/// Reads the effective decoded-page cache budget in bytes.
pub fn page_cache_budget_bytes() -> u64 {
    env::var("XCVT_OCR_PAGE_CACHE_BYTES")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_PAGE_CACHE_BUDGET_BYTES)
}

/// Decoded footprint of a bitmap. `DynamicImage` owns one tightly-packed
/// buffer, so width x height x bytes-per-pixel is exact rather than an
/// estimate.
fn decoded_bytes(img: &DynamicImage) -> u64 {
    img.width() as u64 * img.height() as u64 * img.color().bytes_per_pixel() as u64
}

struct LruInner {
    map: HashMap<u32, Arc<DynamicImage>>,
    order: VecDeque<u32>,
    capacity: usize,
    budget_bytes: u64,
    used_bytes: u64,
}

impl LruInner {
    fn new(capacity: usize, budget_bytes: u64) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            capacity,
            budget_bytes,
            used_bytes: 0,
        }
    }

    fn get(&mut self, page: u32) -> Option<Arc<DynamicImage>> {
        let img = self.map.get(&page).cloned()?;
        if let Some(idx) = self.order.iter().position(|p| *p == page) {
            self.order.remove(idx);
        }
        self.order.push_back(page);
        Some(img)
    }

    fn insert(&mut self, page: u32, img: Arc<DynamicImage>) {
        self.used_bytes += decoded_bytes(&img);
        if let Some(previous) = self.map.insert(page, img) {
            self.used_bytes = self.used_bytes.saturating_sub(decoded_bytes(&previous));
            if let Some(idx) = self.order.iter().position(|p| *p == page) {
                self.order.remove(idx);
            }
        }
        self.order.push_back(page);

        // Evict on whichever ceiling bites first, but never drop the entry we
        // just inserted: a single page larger than the whole budget must still
        // be servable, otherwise the caller re-renders it on every access.
        while (self.order.len() > self.capacity || self.used_bytes > self.budget_bytes)
            && self.order.len() > 1
        {
            let Some(victim) = self.order.pop_front() else {
                break;
            };
            if let Some(dropped) = self.map.remove(&victim) {
                self.used_bytes = self.used_bytes.saturating_sub(decoded_bytes(&dropped));
            }
        }
    }
}

impl PageLoader {
    /// `lru_capacity` should track the caller's OCR worker-pool width plus
    /// one slack slot, so a full complement of in-flight workers spread
    /// across distinct pages can't thrash the cache. Floored at
    /// [`MIN_PAGE_LRU_CAPACITY`], and bounded a second time by
    /// [`page_cache_budget_bytes`] so oversized pages can't turn that slot
    /// count into gigabytes.
    ///
    /// `max_long_edge` clamps the render resolution — see
    /// [`crate::pdf::ocr_max_long_edge`]. Pass `None` for callers that crop
    /// regions out of the page (the grouped runner), `Some(..)` for callers
    /// that send the whole page to the model.
    pub fn new(
        state: Arc<AppState>,
        kind: FileKind,
        path: PathBuf,
        ocr_dpi: u32,
        lru_capacity: usize,
        max_long_edge: Option<u32>,
    ) -> Self {
        Self {
            state,
            kind,
            path,
            ocr_dpi,
            max_long_edge,
            image_bitmap: OnceCell::new(),
            pdf_cache: Mutex::new(LruInner::new(
                lru_capacity.max(MIN_PAGE_LRU_CAPACITY),
                page_cache_budget_bytes(),
            )),
            pdf_in_flight: Mutex::new(HashMap::new()),
        }
    }

    /// Returns a cached or freshly-rendered bitmap for `page`. The supplied
    /// `cancel` token races the load: if it fires before the bitmap is
    /// ready, the caller gets `AppError::Cancelled` immediately rather than
    /// blocking on the in-flight render.
    pub async fn get(&self, page: u32, cancel: &CancellationToken) -> AppResult<Arc<DynamicImage>> {
        if matches!(self.kind, FileKind::Image) {
            return self.load_image(cancel).await;
        }
        self.load_pdf_page(page, cancel).await
    }

    async fn load_image(&self, cancel: &CancellationToken) -> AppResult<Arc<DynamicImage>> {
        let init = self.image_bitmap.get_or_try_init(|| async {
            let path = self.path.clone();
            let img = tokio::task::spawn_blocking(move || crate::image::load_from_disk(&path))
                .await
                .map_err(|e| AppError::Internal(format!("image load join: {e}")))??;
            Ok::<_, AppError>(Arc::new(img))
        });

        let arc = tokio::select! {
            r = init => r?,
            _ = cancel.cancelled() => return Err(AppError::Cancelled("image load".into())),
        };
        Ok(Arc::clone(arc))
    }

    async fn load_pdf_page(
        &self,
        page: u32,
        cancel: &CancellationToken,
    ) -> AppResult<Arc<DynamicImage>> {
        if let Some(img) = self.pdf_cache.lock().await.get(page) {
            return Ok(img);
        }

        // Find or create the in-flight cell for this page. `Weak` means we
        // never have to reap stale entries: the slot self-evicts once the
        // last waiter drops its `Arc<OnceCell>`.
        let cell: Arc<OnceCell<Arc<DynamicImage>>> = {
            let mut in_flight = self.pdf_in_flight.lock().await;
            match in_flight.get(&page).and_then(Weak::upgrade) {
                Some(existing) => existing,
                None => {
                    let new_cell: Arc<OnceCell<Arc<DynamicImage>>> = Arc::new(OnceCell::new());
                    in_flight.insert(page, Arc::downgrade(&new_cell));
                    new_cell
                }
            }
        };

        let state = Arc::clone(&self.state);
        let path = self.path.clone();
        let dpi = self.ocr_dpi;
        let max_long_edge = self.max_long_edge;
        let cancel_for_task = cancel.clone();

        let init = cell.get_or_try_init(|| async move {
            // Cancellable variant: if `cancel_for_task` fires before the
            // task is pulled from the worker queue, it's skipped at pull
            // time. An already-running PDFium render still completes (no
            // abort API) but the result is dropped silently below.
            //
            // Shares the single `PdfWorker` with the preview path — see
            // `AppState` for why we can't run two PDFium workers in one
            // process. The `PageLoader` LRU + dedup keep the worker
            // queue from filling up, so preview latency stays bounded.
            let img = state
                .pdf
                .render_image_cancellable(path, page, dpi, max_long_edge, Some(cancel_for_task))
                .await?;
            Ok::<_, AppError>(Arc::new(img))
        });

        let arc = tokio::select! {
            r = init => r?,
            _ = cancel.cancelled() => return Err(AppError::Cancelled("pdf page render".into())),
        };

        self.pdf_cache.lock().await.insert(page, Arc::clone(arc));
        Ok(Arc::clone(arc))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    fn flat(w: u32) -> Arc<DynamicImage> {
        let buf: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_pixel(w, 1, Rgba([1, 2, 3, 255]));
        Arc::new(DynamicImage::ImageRgba8(buf))
    }

    #[test]
    fn lru_evicts_oldest_when_over_capacity() {
        let mut lru = LruInner::new(2, u64::MAX);
        lru.insert(1, flat(10));
        lru.insert(2, flat(20));
        lru.insert(3, flat(30));
        assert!(lru.get(1).is_none(), "page 1 should have been evicted");
        assert!(lru.get(2).is_some());
        assert!(lru.get(3).is_some());
    }

    #[test]
    fn lru_promotes_on_hit() {
        let mut lru = LruInner::new(2, u64::MAX);
        lru.insert(1, flat(10));
        lru.insert(2, flat(20));
        // Touch 1 so 2 becomes the eviction candidate.
        let _ = lru.get(1);
        lru.insert(3, flat(30));
        assert!(
            lru.get(1).is_some(),
            "page 1 should survive after promotion"
        );
        assert!(lru.get(2).is_none());
        assert!(lru.get(3).is_some());
    }

    #[test]
    fn lru_reinsert_replaces_value_in_place() {
        let mut lru = LruInner::new(2, u64::MAX);
        lru.insert(1, flat(10));
        lru.insert(1, flat(99));
        let img = lru.get(1).unwrap();
        assert_eq!(img.width(), 99);
    }

    #[test]
    fn lru_evicts_on_the_byte_budget_before_the_slot_count() {
        // Slot count says 10 fit; the budget only covers two of these pages.
        // `flat(w)` is w x 1 RGBA = w*4 bytes.
        let mut lru = LruInner::new(10, 900);
        lru.insert(1, flat(100)); // 400 bytes
        lru.insert(2, flat(100)); // 800 total
        lru.insert(3, flat(100)); // 1200 -> over budget, page 1 goes

        assert!(lru.get(1).is_none(), "page 1 should be evicted on bytes");
        assert!(lru.get(2).is_some());
        assert!(lru.get(3).is_some());
        assert_eq!(lru.used_bytes, 800);
    }

    #[test]
    fn lru_keeps_a_page_larger_than_the_whole_budget() {
        // Otherwise the caller re-renders this page on every single access,
        // which is far worse than briefly exceeding the budget.
        let mut lru = LruInner::new(4, 100);
        lru.insert(1, flat(1000)); // 4000 bytes, way over budget
        assert!(
            lru.get(1).is_some(),
            "the just-inserted page must stay resident"
        );
    }

    #[test]
    fn lru_byte_accounting_survives_replacement_and_eviction() {
        let mut lru = LruInner::new(10, u64::MAX);
        lru.insert(1, flat(100)); // 400
        lru.insert(2, flat(50)); // 200 -> 600
        assert_eq!(lru.used_bytes, 600);

        lru.insert(1, flat(10)); // replaces 400 with 40 -> 240
        assert_eq!(lru.used_bytes, 240);

        // Now squeeze the budget and confirm the counter tracks the evictions.
        lru.budget_bytes = 100;
        lru.insert(3, flat(10)); // +40 -> 280, evict until <= 100
        assert!(lru.used_bytes <= 100, "got {}", lru.used_bytes);
    }
}
