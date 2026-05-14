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
//! - For PDFs: keeps a small LRU of decoded pages. Workers ask for a page
//!   on demand; the loader either serves a cached `Arc<DynamicImage>` or
//!   dispatches a `render_image` call to the dedicated PdfWorker thread.
//!   Cache capacity is small enough that the steady-state footprint is
//!   `OCR_CONCURRENCY × page_size` rather than `referenced_pages × page_size`.
//!
//! There is no in-flight dedupe: two concurrent workers asking for the same
//! page may each trigger a render. The PdfWorker queues them sequentially
//! so the wall-clock cost is one extra render per collision; the memory cost
//! is bounded by `Arc` strong counts dropping when workers finish with the
//! bitmap. For typical workloads (sorted-by-page items in grouped mode,
//! page-per-worker in whole-file mode) collisions are rare.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;

use image::DynamicImage;
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, OnceCell};

use super::grouped::FileKind;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Number of decoded PDF pages held in the LRU at any time. Sized to cover
/// the OCR worker pool (`OCR_CONCURRENCY = 3`) plus a small slack so a worker
/// switching pages doesn't immediately evict its own bitmap.
pub const PAGE_LRU_CAPACITY: usize = 4;

pub struct PageLoader {
    app: AppHandle,
    kind: FileKind,
    path: PathBuf,
    ocr_dpi: u32,
    image_bitmap: OnceCell<Arc<DynamicImage>>,
    pdf_cache: Mutex<LruInner>,
}

struct LruInner {
    map: HashMap<u32, Arc<DynamicImage>>,
    order: VecDeque<u32>,
    capacity: usize,
}

impl LruInner {
    fn new(capacity: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            capacity,
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
        if self.map.insert(page, img).is_some() {
            if let Some(idx) = self.order.iter().position(|p| *p == page) {
                self.order.remove(idx);
            }
        }
        self.order.push_back(page);
        while self.order.len() > self.capacity {
            if let Some(victim) = self.order.pop_front() {
                self.map.remove(&victim);
            }
        }
    }
}

impl PageLoader {
    pub fn new(app: AppHandle, kind: FileKind, path: PathBuf, ocr_dpi: u32) -> Self {
        Self {
            app,
            kind,
            path,
            ocr_dpi,
            image_bitmap: OnceCell::new(),
            pdf_cache: Mutex::new(LruInner::new(PAGE_LRU_CAPACITY)),
        }
    }

    /// Returns a cached or freshly-rendered bitmap for `page`. Caller-side
    /// failures (cancellation, render error, image load error) are surfaced
    /// directly. The same `Arc` is returned to every caller asking for the
    /// same page until eviction.
    pub async fn get(&self, page: u32) -> AppResult<Arc<DynamicImage>> {
        if matches!(self.kind, FileKind::Image) {
            return self.load_image().await;
        }
        self.load_pdf_page(page).await
    }

    async fn load_image(&self) -> AppResult<Arc<DynamicImage>> {
        let arc = self
            .image_bitmap
            .get_or_try_init(|| async {
                let path = self.path.clone();
                let img = tokio::task::spawn_blocking(move || crate::image::load_from_disk(&path))
                    .await
                    .map_err(|e| AppError::Internal(format!("image load join: {e}")))??;
                Ok::<_, AppError>(Arc::new(img))
            })
            .await?;
        Ok(Arc::clone(arc))
    }

    async fn load_pdf_page(&self, page: u32) -> AppResult<Arc<DynamicImage>> {
        if let Some(img) = self.pdf_cache.lock().await.get(page) {
            return Ok(img);
        }
        // OCR-grade renders go through the dedicated `pdf_ocr` worker so
        // they don't contend with preview renders driven by user navigation.
        let img = self
            .app
            .state::<AppState>()
            .pdf_ocr
            .render_image(self.path.clone(), page, self.ocr_dpi)
            .await?;
        let arc = Arc::new(img);
        self.pdf_cache.lock().await.insert(page, Arc::clone(&arc));
        Ok(arc)
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
        let mut lru = LruInner::new(2);
        lru.insert(1, flat(10));
        lru.insert(2, flat(20));
        lru.insert(3, flat(30));
        assert!(lru.get(1).is_none(), "page 1 should have been evicted");
        assert!(lru.get(2).is_some());
        assert!(lru.get(3).is_some());
    }

    #[test]
    fn lru_promotes_on_hit() {
        let mut lru = LruInner::new(2);
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
        let mut lru = LruInner::new(2);
        lru.insert(1, flat(10));
        lru.insert(1, flat(99));
        let img = lru.get(1).unwrap();
        assert_eq!(img.width(), 99);
    }
}
