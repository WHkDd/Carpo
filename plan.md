# xcvt-tauri Implementation Plan

> **Status (M0–M4 complete · M5 next · 2026-05-11)**: Tauri 2 + React 18 + Vite + TS + Tailwind + shadcn/ui chrome shipped. M1 raster image loading + canvas, M2 PDF queue + bitmap LRU + collapsed rail, M3 manual block drawing + multi-select transformer + nudge/delete keyboard shortcuts, M4 document-scoped article grouping + metadata + profile toggle + grouped-block edit-mode all landed and behind static gates (`pnpm typecheck`, `pnpm build`, `npx vitest run`, `cargo check`, `cargo clippy -- -D warnings`, `cargo test`). Authoritative design rationale in [`PRODUCT.md`](./PRODUCT.md) + [`DESIGN.md`](./DESIGN.md); implementation map in [`docs/DESIGN.md`](./docs/DESIGN.md); high-fidelity mockups in [`docs/mockups/*.html`](./docs/mockups/).
>
> **Reference implementation**: `/Users/kai/superconductor/projects/xcvt/newspaper_ocr.py` (2,859 lines) — every feature, parameter, and prompt format must match unless this plan explicitly says otherwise.
>
> **Top-level plan (rationale, risks, milestones)**: `/Users/kai/.claude/plans/tauri-macos-windows-humble-ritchie.md`.

This file is for an autonomous agent (e.g. codex) to drive implementation milestone-by-milestone. Each task has a clear acceptance gate; check it off before moving on. Tasks tagged **[UI]** must be left for the human/Claude UI loop — they require visual review against the mockups. Tasks tagged **[BE]** are backend-only and can be completed without visual review.

---

## Conventions

- **Branch per milestone**: `m1-canvas`, `m2-pdf-queue`, etc. Squash-merge into `main` when the milestone passes its acceptance gate.
- **Commits**: single-purpose, conventional prefix (`feat:`, `fix:`, `refactor:`, `chore:`, `test:`, `docs:`). Reference task ids when possible (e.g. `feat(m2): T2.3 pdf page navigation`).
- **Verify before checking off**: `pnpm typecheck && pnpm build && (cd src-tauri && cargo check && cargo clippy -- -D warnings && cargo test)`. Tauri dev smoke test (`pnpm tauri dev`) must open the window without runtime errors at the end of every milestone.
- **No new dependencies** without listing them in the milestone header (see "Dependencies added" lines below). Pin exact versions where the plan specifies them.
- **State management**: `zustand` with `immer` middleware. Each slice is its own file under `src/store/`; combine in `src/store/index.ts`. Slices listed in [`docs/DESIGN.md`](./docs/DESIGN.md) — do not invent new top-level slices without listing the rationale here.
- **Rust error handling**: every `tauri::command` returns `AppResult<T>` (the `error::AppError` type already in `src-tauri/src/error.rs`). Add new variants there as needed.
- **IPC contract**: types in `src/lib/ipc-types.ts` mirror Rust DTOs by hand. When adding a new command, add the wrapper to `src/lib/tauri.ts` *and* update `ipc-types.ts` in the same commit.
- **Konva color binding**: Konva renders into raw canvas and doesn't honor CSS variables. Use a `getComputedStyle(document.documentElement).getPropertyValue('--article-N')` helper (planned in `src/lib/article-color-token.ts`, T3.7).
- **Reduced motion**: every animation must respect `prefers-reduced-motion` (the rule is already in `globals.css`).
- **Logs**: use `log::info!`/`log::warn!`/`log::error!` in Rust; `import { info, warn, error } from '@tauri-apps/plugin-log'` in TS. No `println!` / `console.log` past M1 except in test code.

---

## M1 — Canvas + single image (3-4 days · all [UI] tasks subject to visual review)

**Goal**: drop a JPG/PNG/TIFF/BMP onto the window → image renders inside Konva canvas → pan with drag, zoom 1-800% with wheel + spinner, ⌘0 fits.

**Dependencies added**: Rust `image = "0.25"` (features `png, jpeg, tiff, bmp`); no new JS deps (konva, react-konva, use-image already installed).

### ~~T1.1~~ [BE] · Rust `image` crate + `load_raster_image` command
- Uncomment the `image = "0.25"` line in `src-tauri/Cargo.toml`.
- Create `src-tauri/src/image.rs` with `load_from_disk(path: &Path) -> AppResult<DynamicImage>` that handles PNG/JPEG/JPG/TIFF/TIF/BMP via `image::open`. Map errors to `AppError::Image(format!(...))`. Reject unsupported extensions with `AppError::FileNotFound` if file missing or `AppError::Image("unsupported format")` otherwise.
- Add `to_png_base64(img: &DynamicImage) -> AppResult<String>` using `image::ImageOutputFormat::Png` + `base64::engine::general_purpose::STANDARD`.
- Create `src-tauri/src/commands/mod.rs` and `src-tauri/src/commands/files.rs` with `#[tauri::command] async fn load_raster_image(path: String) -> AppResult<RenderedPagePayload>` returning `{ width, height, png_base64 }`. Mirror the DTO in `src/lib/ipc-types.ts` (already exists — verify match).
- Also add `#[tauri::command] async fn list_supported_extensions() -> Vec<&'static str>` returning `["png", "jpg", "jpeg", "tif", "tiff", "bmp"]`.
- Wire both commands into `src-tauri/src/lib.rs` `invoke_handler!`. Declare the `commands` module + `image` module.
- **Acceptance**: `cargo test` includes a unit test that loads a 64×64 fixture PNG (commit one to `src-tauri/tests/fixtures/sample.png`) and asserts `width == 64 && png_base64.starts_with("iVBORw0KGgo")`. `cargo clippy` clean.

### ~~T1.2~~ [BE] · Frontend tauri.ts wrappers
- Add `loadRasterImage(path)` and `listSupportedExtensions()` to `src/lib/tauri.ts`. Types from `ipc-types.ts`.
- **Acceptance**: `pnpm typecheck` passes. The signature should match `src-tauri/src/commands/files.rs` exactly.

### T1.3 [UI] · AppShell layout (queue + canvas + text structure + StatusBar)
- Implement `src/components/layout/AppShell.tsx`: full-height grid with left queue, top document status, center canvas, right scanned-text structure rail, and bottom status bar. Background is near-white; only the canvas backing uses `bg-canvas`.
- `src/components/layout/Toolbar.tsx`: stub document title + page navigation matching `docs/mockups/xcvt-scan-structure-preview.html`. Do not add an app-name chip in the top-left area.
- `src/components/layout/StatusBar.tsx`: OCR profile, zoom control, batch progress text, and the single primary OCR action. Use `font-mono tabular-nums` for numbers.
- Replace the placeholder `src/App.tsx` with `<AppShell/>` rendering an empty `<ImageCanvas/>` (T1.4) in the canvas region.
- **Acceptance**: visual diff against `docs/mockups/xcvt-scan-structure-preview.html` top and bottom regions. Heights, paddings, font sizes match mockup. **Must be reviewed by human/Claude before merging.**
- **Deviation (2026-05-08)**: layout shipped with the canvas as a full-bleed rounded card and Toolbar/StatusBar as floating chips (`bg-background/75`) over the canvas, instead of fixed top/bottom bands matching the mockup. The "添加文件" entry point lives in the queue rail header. The toolbar's prev/next page nav + `N / M` indicator were dropped (not stubbed) — re-add them in **T2.4** when real `pdfTotal`/`currentPage` exist; until then a stub is just visual noise. Batch progress + "识别选中报道" primary action moved into the **right rail footer**.

### T1.4 [UI+BE] · `<ImageCanvas/>` Konva stage + image rendering
- `src/components/canvas/ImageCanvas.tsx`: `react-konva` `<Stage/>` filling parent (use `useResizeObserver` or sized via `ref` measurement). Single `<Layer listening={false}><KonvaImage/></Layer>` for the image. The image source is a `RenderedPagePayload` from store (T1.6 populates it).
- Use `use-image` hook with a `data:image/png;base64,...` URL built from `png_base64`. **NOT** ObjectURL for M1 (we'll switch to ObjectURL+Blob in M2 once we're rendering large bitmaps); base64 is fine for single image, simpler to debug.
- Stage `pixelRatio={1}` (avoid retina double-memory).
- **Acceptance** [BE part]: code compiles, no console errors, empty stage renders a `bg-background`-colored rect when no image. [UI part]: when image loads, it appears centered with no scaling applied initially (1:1).

### T1.5 [UI+BE] · Pan/zoom + status bar zoom sync + ⌘0 fit
- `src/components/canvas/usePanZoom.ts` hook returning `{stageScale, stagePosition, onWheel, onDragStart, onDragMove, fitToWindow}`. Wheel: `Math.pow(1.15, ±notch)`, clamped to `[0.01, 8]`. Drag: standard Konva stage `draggable` mode. Fit: compute bounding ratio against current stage size.
- Mutate via `useUiStore((s) => s.setZoomPercent)` etc — store slice (T1.7).
- `src/components/layout/StatusBar.tsx` zoom area: `−` button (×0.87), input (editable, parses `NN%`), `+` button (×1.15), `适应` text button (calls fit). Bidirectional binding to store.
- Hotkey: `⌘0` (mac) / `Ctrl+0` (win) → fit. Use `useEffect` keydown listener at AppShell level. **Bonus**: also `⌘=`/`⌘-` for zoom in/out.
- **Acceptance**: load any image, wheel to zoom (must clamp at 100% and 800% with no flicker), drag to pan, click `+`/`-`/`适应`, type `200%` into input → image zooms to 200%. ⌘0 fits.

### T1.6 [UI+BE] · File open + drag-drop import
- `src/store/queueSlice.ts`: minimal slice for M1 — `files: FileEntry[]`, `currentFileId: string | null`, `addFile(entry)`, `setCurrent(id)`. `FileEntry` from `ipc-types.ts` extended with optional `payload: RenderedPagePayload`.
- `src/components/layout/Toolbar.tsx` "添加文件" button → `@tauri-apps/plugin-dialog` `open({ multiple: true, filters: [{name: 'Images', extensions: await listSupportedExtensions()}] })` → for each path, call `loadRasterImage(path)` and `addFile()` to store.
- Drag-drop: `tauri.conf.json` already has `dragDropEnabled: true`. Listen to `tauri://drag-drop` event in a top-level `useEffect` at `App.tsx`. Filter paths by supported extensions (case-insensitive). Same handler as button.
- When a file is added and `currentFileId` is null, set it to the new file. `<ImageCanvas/>` reads the current file's `payload` and renders.
- **Acceptance**: drag a PNG onto the running window → image appears, status bar updates to filename + size. Click "添加文件" → dialog opens, multi-select works, each chosen file appears in store and the *first* selected becomes current. Dropping unsupported types (e.g. `.txt`) is silently ignored, no error.

### ~~T1.7~~ [BE] · Store slices (queue + ui)
- `src/store/queueSlice.ts` (described above).
- `src/store/uiSlice.ts`: `zoomPercent: number (1..800)`, `setZoomPercent(p: number)`, `statusText: string`, `setStatusText(s: string)`. zoom updates from canvas wheel land here.
- `src/store/index.ts`: `useStore` combines both via zustand `create()`. **Avoid** a single mega-store — each slice file exports a typed creator; the combined store imports them.
- **Acceptance**: typecheck clean. No store mutations outside slice action functions.

### T1.8 [UI] · M1 visual polish pass
- Compare running app to `docs/mockups/xcvt-scan-structure-preview.html`. Adjust spacing, text sizes, hover states until parity. Pay attention to the near-white chrome, gray canvas only, sparse dividers, restrained controls, and `tabular-nums` everywhere a number lives.
- Fix any FOUC (favor `media="screen"` not deferred CSS).
- **Acceptance**: side-by-side screenshot vs mockup looks identical at default window size. **Human/Claude review required.**

### T1.9 · Verify M1 end-to-end (smoke gate)
- `pnpm tauri dev` on macOS, drop a TIFF, then a JPG, then a PNG, then a BMP. All render. Wheel zooms. Drag pans. ⌘0 fits. Status bar updates.
- Run `pnpm typecheck`, `pnpm build`, `cd src-tauri && cargo clippy -- -D warnings && cargo test`. All green.
- Document any minor TODOs as code `// TODO(m2): ...` comments. **Don't** leave silent skips.

---

## M2 — PDF rendering + multi-file queue (3-4 days)

**Goal**: render multi-page PDFs at preview DPI; navigate pages; queue panel with multiple files; per-file state preserved on switch.

**Dependencies added**: Rust `pdfium-render = { version = "0.8", features = ["thread_safe"] }`; pdfium binary fetch script + cache scaffolding.

**Risk**: pdfium binary distribution. See top-level plan §3 — use `bblanchon/pdfium-binaries` releases; bundle into `src-tauri/pdfium/<arch>/`; load via `Pdfium::bind_to_library`. CI cache key on `src-tauri/pdfium/VERSION`.

- QUESTION(m2): latest `bblanchon/pdfium-binaries` was verified as `chromium/7825` on 2026-05-08, but `pdfium-render 0.8.37` only exposes non-future bindings through `chromium/7543`; `src-tauri/pdfium/VERSION` is pinned to `chromium/7543` until the Rust dependency is upgraded and re-tested.

### ~~T2.1~~ [BE] · pdfium binary fetch infrastructure
- Create `src-tauri/pdfium/VERSION` containing `chromium/6996` (or current latest from bblanchon — verify before pinning).
- Create `src-tauri/scripts/fetch_pdfium.sh` (bash) and `src-tauri/scripts/fetch_pdfium.ps1` (PowerShell). Each takes one arg: `macos-arm64 | macos-x64 | windows-x64`. Downloads matching tarball from `https://github.com/bblanchon/pdfium-binaries/releases/download/<VERSION>/pdfium-<arch>.tgz`, verifies SHA-256 against a checksum file, extracts `lib/libpdfium.dylib` or `bin/pdfium.dll` into `src-tauri/pdfium/<arch>/`.
- Maintain `src-tauri/pdfium/SHA256SUMS` with one line per arch.
- Update `.gitignore` (already done) and verify `src-tauri/pdfium/<arch>/*` patterns are ignored.
- Add `prepare:pdfium` npm script that runs the appropriate fetch script for the current host arch.
- **Acceptance**: `pnpm prepare:pdfium` on macOS arm64 populates `src-tauri/pdfium/macos-arm64/libpdfium.dylib` (>5 MB).

### ~~T2.2~~ [BE] · Rust pdfium init + render_page command
- Uncomment `pdfium-render` in `Cargo.toml`. Add `directories` if not already present (it is).
- `src-tauri/src/pdf.rs`:
  - `init_pdfium() -> AppResult<Pdfium>`: locate libpdfium next to executable on macOS (`Frameworks/`) or Windows (same dir); fall back to `src-tauri/pdfium/<arch>/` for `cargo run` development. Use `Pdfium::bind_to_library`.
  - `page_count(path: &Path) -> AppResult<u32>`.
  - `render_page(path: &Path, page: u32, dpi: u32) -> AppResult<RenderedPage { width, height, png_bytes }>`. Render via pdfium at `dpi/72` scale; encode PNG via `image::DynamicImage::write_to`.
- `src-tauri/src/state.rs`: introduce `AppState { pdfium: Arc<Pdfium>, http: reqwest::Client, ... }`, build once in `lib.rs setup()`, `app.manage(state)`.
- `src-tauri/src/commands/render.rs`:
  - `get_pdf_info(path) -> PdfInfo { page_count, title }`
  - `render_page(path, page, dpi, purpose) -> RenderedPagePayload`
- Wire into `invoke_handler!`.
- Update `tauri.conf.json` `bundle` section to include the dylib (macOS `frameworks: ["pdfium/macos-arm64/libpdfium.dylib"]` — but this needs to be arch-aware via build profile; in M2 just hardcode arm64, parametrize in M7).
- **Acceptance**: `cargo test` includes a fixture 2-page PDF (`src-tauri/tests/fixtures/sample.pdf` — generate or commit a tiny one) and asserts page count + first-page render returns >0 bytes of PNG.

### T2.3 [UI+BE] · QueuePanel with file list
- `src/store/queueSlice.ts`: extend with `pdfTotal: number`, `currentPage: number`, `removeFile(id)`. Track per-file state.
- ~~T2.3-BE scaffold~~ (2026-05-08): `queueSlice` now exposes current `pdfTotal/currentPage`, tracks those fields per file, and supports `removeFile(id)`; JSX queue rendering remains for the UI loop.
- `src/components/queue/QueuePanel.tsx`: left queue rail mirroring `docs/mockups/xcvt-scan-structure-preview.html`. Header counts files; scrollable list of `<QueueItem/>`; keep bulk actions out of the rail unless they become real active workflows.
- `src/components/queue/QueueItem.tsx`: filename, ext icon (PDF vs image), page indicator `N / M` for PDFs, status icon (✓/⋯/!N). Active item gets the 2px primary stripe (`queue-item-active` from mockup).
- Click switches `currentFileId`; image canvas reloads.
- **Acceptance**: load a mix of PDF + images; click each — canvas updates within 500ms (preview render only); current page indicator updates.

### T2.4 [UI+BE] · PDF page navigation
- Toolbar prev/next buttons + page indicator (mockup lines 121-129). Wire to store: `prevPage()`/`nextPage()` clamp to `[1, pdfTotal]`.
- ~~T2.4-BE scaffold~~ (2026-05-08): `queueSlice` exposes clamped `prevPage()`/`nextPage()` actions and `currentPage/pdfTotal` for the floating toolbar; JSX and render-on-change wiring remain for the UI loop.
- **Note (carried from T1.3)**: M1 deliberately did *not* stub these — re-introduce them inside the floating top chip in `src/components/layout/Toolbar.tsx`. Render only when `currentFile.kind === "pdf"` and `pdfTotal > 1`; show `${currentPage} / ${pdfTotal}` between the prev/next buttons.
- Hotkeys: `←` / `→` arrow keys.
- On page change: call `render_page(path, newPage, 150, "preview")` and update current file's payload. Cache rendered bitmaps in front-end LRU (T2.5).
- **Acceptance**: load a 5-page PDF; arrow keys navigate; page indicator updates; render <500ms per page.

### ~~T2.5~~ [BE] · Frontend bitmap LRU cache
- `src/hooks/usePageBitmapCache.ts`: LRU keyed by `${fileId}::${page}::${dpi}`, capacity 12 preview entries. Stores `{blob: Blob, url: string}`. Evict on capacity → `URL.revokeObjectURL`.
- ImageCanvas reads from cache before requesting; falls back to `render_page` invocation, then writes back.
- Switch from base64 data URL (M1 simple path) to Blob+ObjectURL approach: build `Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], {type:'image/png'})` once on receipt; store URL.
- **Acceptance**: navigate 5-page PDF forward + backward — second visit to a page renders instantly (no network/IPC log).

### T2.6 [UI+BE] · Per-file state preservation across switch
- `src/store/pageStateSlice.ts`: `pageStates: Record<string, PageState>` keyed `${fileId}::${page}`. M2 tracks: `zoomPercent`, `panX`, `panY` per (file, page). M3 will add blocks/articles.
- ~~T2.6-BE scaffold~~ (2026-05-08): `pageStateSlice` added with `${fileId}::${page}` keys and M2 `zoomPercent/panX/panY` actions; UI capture/restore wiring remains for the UI loop.
- Switching file: capture current pan/zoom into pageStates, restore the new file's pageStates.
- **Acceptance**: zoom into file A page 2 to 200%, switch to file B (zoom resets to fit), switch back to file A — page 2 still at 200% pan position.

### ~~T2.7~~ [UI] · QueuePanel collapsed icon-rail mode
- Header chevron toggles `bg-surface` → 56px-wide rail showing only ext icons + status dot. Tooltip on hover shows filename. Persist collapsed state in `uiSlice`.
- ~~T2.7~~ (2026-05-09): `uiSlice.queueCollapsed` + `toggleQueueCollapsed`; `AppShell` switches the left grid track between 244px↔56px; `QueuePanel` renders compact-rail variant with `QueueItemCompact` (icon + active stripe + dot, native `title` tooltip).
- **Acceptance**: collapse toggle works; tooltips legible; expand restores full panel.

### T2.8 · Verify M2 end-to-end (smoke gate)
- Load 3 files (1 PDF, 2 images). Switch between them. Navigate PDF pages. Collapse/expand queue. All states preserve correctly.
- Run on macOS arm64; **also build for x64 (Rosetta) and Windows** if possible — pdfium binary path resolution is the highest-risk piece.
- All commands clean; no clippy warnings.
- Static gates passed 2026-05-09 on macOS arm64: `pnpm typecheck`, `pnpm build`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (3 suites). Interactive multi-file smoke + cross-arch builds remain for human/CI verification.

---

## M3 — Block drawing & manipulation (4-5 days)

**Goal**: manual draw mode toggle; click-drag to create blocks; multi-select transformer; 8-handle resize; drag-move; selection-order labels; ⌘Z undo selection; Delete key; right-click delete on unassigned single block.

**Dependencies added**: none (Konva already in).

**Status (2026-05-11)**: M3 is implemented on branch `m2-pdf-queue` through `fix(m3): T3.7 T3.8 polish canvas interactions`. Static gates are green: `pnpm typecheck`, `pnpm build`, `npx vitest run`, `cargo check`, `cargo clippy -- -D warnings`, `cargo test`.

**Boundary for M4**: M3 owns only block geometry and temporary selection. It must not encode final article semantics beyond the fields needed by later milestones. A block should remain visible unless the user explicitly deletes it via Delete/Backspace or the block context menu.

### ~~T3.1~~ [BE] · Block + Article + Selection store slices
- `src/store/pageStateSlice.ts`: extend `PageState` with `blocks: Block[]`, `articles: Article[]`. `Block { id, x, y, w, h, articleId | null, articleOrder | null }`. `Article { id, num, title }`.
- `src/store/selectionSlice.ts`: `manualDrawMode: boolean`, `selectionOrder: string[]` (block ids). Actions: `toggleDrawMode()`, `pushSelection(id)`, `popSelection()`, `clearSelection()`, `removeFromSelection(id)`.
- All actions immer-mutate.
- **Acceptance**: typecheck clean. Unit tests for selection-order invariants under push/pop/remove.

### ~~T3.2~~ [UI+BE] · Manual mode toggle in toolbar
- Wire toolbar "手动模式" button (mockup lines 137-141) to `toggleDrawMode()`. Active state shows the dot indicator + `bg-primary-muted`.
- **Acceptance**: toggle works visually; dot indicator reflects state.

### ~~T3.3~~ [UI+BE] · `useDrawBlock` state machine
- `src/components/canvas/useDrawBlock.ts`: only active when `manualDrawMode === true`. State: `idle | drawing { startX, startY, currentX, currentY }`. Stage `mousedown` (not on existing block, not on transformer) → start. `mousemove` → update with rAF throttle. `mouseup` → if `|w|, |h| >= 16` (image coords) → dispatch `addBlock`; else discard. `Escape` cancels.
- `src/components/canvas/DrawingOverlay.tsx`: renders a dashed `<Rect/>` while drawing.
- **Acceptance**: with manual mode on, click-drag creates rectangle; <16px discarded; ESC cancels.

### ~~T3.4~~ [UI+BE] · `BlockRect` rendering + hover/selected states
- `src/components/canvas/BlockRect.tsx`: Konva `<Rect/>` per block. Fill/stroke colors from `articleHsl(articleId)` helper (T3.7) at 22%/85% alpha, or `--primary` at 38%/100% alpha when selected.
- `mouseenter`/`mouseleave` toggles fill alpha to 32%.
- Click toggles selection (push/remove from `selectionOrder`).
- Stage click on empty area clears selection.
- **Acceptance**: draw 5 blocks; click cycles selection state; visual matches mockup `article-fill-N` styles.

### ~~T3.5~~ [UI+BE] · `BlockLayer` with multi-select Transformer
- `src/components/canvas/BlockLayer.tsx`: layer holding all `BlockRect`s + a singleton `<Transformer/>` whose `nodes` are the currently selected refs. Set `keepRatio={false}`, 8 anchors (TL, T, TR, R, BR, B, BL, L), `rotateEnabled={false}`, `boundBoxFunc` enforcing min size 16×16.
- On `transformend`: read each child's resulting `x, y, scaleX*width, scaleY*height` and write back to store as new `{x, y, w, h}`. Reset `scaleX/Y` to 1 immediately.
- Drag-move: same flow via `onDragEnd` per block (or per-group via Transformer when multi-selected).
- **Acceptance**: multi-select 3 blocks → bounding box appears with 8 handles → drag corner scales all relative; drag body moves all together. Coords persisted to store, survive page-switch.

### ~~T3.6~~ [UI+BE] · Selection-order labels
- `src/components/canvas/SelectionOrderLabel.tsx`: Konva `<Group>` containing a small filled `<Rect>` (background `--primary`) + `<Text>` showing `selectionOrder.indexOf(blockId) + 1`. Rendered only when block is in selectionOrder. Anchored at block's top-left + 4px inset.
- The displayed number is a temporary selection order, not yet the persisted article order. M4 will persist it as `articleOrder` only when the user confirms "标记为报道".
- **Acceptance**: select 3 blocks in order; numbers 1, 2, 3 appear; deselect middle → 1, 2 reflow correctly.

### ~~T3.7~~ [BE] · Article color token bridge
- `src/lib/article-color-token.ts`: `articleHsl(index, alpha = 1)` reads `--article-N` from `getComputedStyle(document.documentElement)` and returns `hsl(... / alpha)`. Cache result; invalidate on `MutationObserver` watching `<html>` class changes (theme switch).
- **Acceptance**: theme switch (set `document.documentElement.classList.toggle('dark')` from devtools) → block fills update without re-mount.

### ~~T3.8~~ [UI+BE] · Keyboard shortcuts
- `src/components/canvas/useKeyboardShortcuts.ts`:
  - `⌘Z` (mac) / `Ctrl+Z` (win) → `popSelection()`.
  - `Del` / `Backspace` → delete all selected blocks (`removeBlock` for each id), clear selection. Show confirm only if >5 blocks selected.
  - Arrow keys nudge selected blocks 1px (image coords); `Shift+Arrow` nudges 8px.
- Right-click on a block → in-canvas context menu with "删除版块" only. (M4 deviation: the planned "解除报道分组" item was dropped — see M4 decision log.)
- **Acceptance**: all shortcuts work; arrow nudge feels smooth; context menu deletes the targeted block(s).

### ~~T3.9~~ [UI] · M3 visual polish + 200-block stress test
- Use a devtools snippet to populate 200 blocks; verify Konva FPS ≥ 55 during pan/zoom/select. If not: add `listening: false` on non-interactive layers; consider `cache()` on the BlockLayer.
- Polish hover/select transitions to 120ms ease-out-quart.
- **Acceptance**: stress test passes; visual review of all states (default, hover, selected, assigned-by-article-1..10).

### ~~T3.10~~ · Verify M3 end-to-end
- Draw 5 blocks, multi-select, resize, drag-move, undo (⌘Z) selection, delete, navigate to another page (blocks persist on page A).

---

## M4 — Article grouping + metadata UI (2 days)

**Goal**: mark selected blocks as a named article; right-rail article list with rename/remove/clear-all; newspaper-name + date inputs; OCR profile toggle (standard/fast).

**Status (2026-05-11)**: M4 shipped via `feat(m4): add article grouping store foundation (#5)`, `feat(m4): add article grouping UI (#6)`, and `feat(m4): protect grouped block identity via edit-mode`. Static gates green.

**Design decision before implementation (2026-05-11)**:
- Articles must be file/document-scoped, not page-scoped. Real newspaper articles can span pages, so M4 should not store final `articles[]` only inside `${fileId}::${page}` page state.
- Blocks remain page-scoped because coordinates belong to a concrete page. Article membership should reference blocks by `{ page, blockId, order }` or an equivalent typed structure.
- `selectionOrder` remains a temporary per-page selection queue. When the user clicks "标记为报道", M4 must create/update a document-scoped article, persist the selected blocks' order as `articleOrder = index + 1`, then clear `selectionOrder`. Clearing selection must not delete or hide the selected block rectangles.
- After marking an article, the selected blocks should stay visible and switch from temporary selected styling to article color styling. The next article selection starts from temporary order `1`.
- A future cross-page workflow should allow appending blocks from another page to the same article without creating a duplicate article. The article list is therefore scoped to the current file, while canvas highlighting only affects blocks present on the current page.
- Metadata is also file/document-scoped for M4: `报刊名` and `日期` are stored once per imported file/document, not separately per page. A later mixed-source PDF workflow can add page-level overrides if needed.

**Decisions captured during M4 implementation (2026-05-11)**:
- **"解除报道分组" removed.** The originally-planned right-click item on grouped blocks ("解除报道分组" + "删除版块") was dropped; the only block context-menu action is now "删除版块". Reason: ungrouping without deleting had no real workflow — the user either wants the block gone, or wants to fix the group by deleting and redrawing. The store still exposes `unassignBlocksFromArticles` for future use, but no UI binds to it.
- **`removeArticle` / `clearArticles` delete the underlying blocks, not just the group bond.** Earlier T4.2 text said "unassigns blocks, removes article" / "reset articleId/articleOrder to null and clear articles[]"; the shipped behavior deletes the blocks too. Reason: an article without its blocks left behind orphaned rectangles the user almost always wanted gone. Tests (`pageStateSlice.test.ts: clearArticles keeps document metadata but deletes all article blocks`) lock this in.
- **Grouped-block edit-mode introduced (`editingBlock` state).** Clicking a grouped block enters a per-file "edit" state instead of joining the selection draft. This preserves `articleId` / `articleOrder` through resize/drag and prevents "标记为报道" from re-claiming the block into a different article. Click an ungrouped block to exit edit-mode; click the empty canvas to clear it. The editing block participates in `Delete` / arrow-nudge when no temporary selection exists.

### ~~T4.1~~ [UI+BE] · "Mark as article" workflow
- Right-rail `<BlockOpsPanel/>` (mockup lines 290-302): "标记为报道" button is enabled iff `selectionOrder.length >= 1`. On click: create or update a file-scoped `Article { id: uuid(), num: nextNum, title: \`报道${nextNum}\`, blockRefs }`, assign each selected block's `articleId = article.id` and `articleOrder = orderInSelection`, then clear selection. Do not remove blocks. Re-color blocks.
- `nextNum` = max existing `num` + 1, scoped per file/document.
- Hotkey `⌘G`.
- **Acceptance**: select 3 blocks → ⌘G → blocks remain visible, turn article-1 colored, article appears in file-level list, temporary labels disappear; selecting the next article starts at label 1.

### ~~T4.2~~ [UI+BE] · Article list with rename/remove/clear-all
- `<ArticleList/>` (mockup lines 305-340): list of articles with badge (cycling `--article-N`), title, block count.
- Click row → highlights that article's blocks on the current canvas page (transient ring stroke at `--accent`). Cross-page blocks remain part of the same article but become visible/highlightable when their page is opened.
- Per-row hover actions: inline rename (pencil icon) and "删除" (trash icon — **deletes the article AND its underlying blocks**, see M4 decision log).
- "全清" button: confirm dialog ("确定清除全部 N 篇报道？") → **deletes every article and all of its blocks** for the current file.
- Renumbering: when deleting article #2 of 4, remaining articles re-number to 1,2,3 and re-color.
- **Acceptance**: full CRUD on articles; visual state synced to canvas blocks.

### ~~T4.3~~ [UI+BE] · MetadataInline + ProfileToggle
- `<MetadataInline/>` (mockup lines 274-287): two text inputs `报刊名` + `日期`. Bound to `documentStates[currentFileId].newspaperName` / `.newspaperDate`.
- Product decision (2026-05-11): metadata is file/document-scoped, matching the normal one-file/one-newspaper-issue OCR workflow. Do not bind these fields to `pageStates`.
- `<ProfileToggle/>` in BlockOpsPanel: segmented toggle "标准 / 快速" bound to `settingsSlice.ocrProfile`.
- **Acceptance**: typing persists across page navigation; toggle changes profile (verifiable via store devtools).

### ~~T4.4~~ · Verify M4 end-to-end
- Mark 5 articles in different colors. Rename, remove, clear all. Switch pages → file-level article list persists; current page only shows that page's blocks. Visual matches mockup right-rail.

---

## M5 — OCR providers + grouped block OCR (5-6 days)

**Goal**: settings dialog with 4 provider panels + keychain integration; OcrProvider trait + retry; `start_grouped_ocr` job emitting progress events; ProgressDialog; document assembly. End-to-end: select articles → click "生成文档" → progress streams → result drawer fills.

**Dependencies added**: Rust `wiremock` already in dev-deps. No new runtime deps.

**Deviation (2026-05-11)**: provider lineup changed from `paddleocr/openai/claude/openrouter` to `paddleocr/openai/openrouter/openai_compatible`. Anthropic native API is dropped — Claude is still reachable via the OpenAI-compatible custom endpoint or OpenRouter. The OpenAI-compatible provider accepts a user-supplied `base_url` + key and exposes "刷新模型" against `${base_url}/v1/models`. Prefer the latest official SDK / current API surfaces over byte-for-byte parity with `newspaper_ocr.py:359-478` — that file remains a reference for prompt + result shape, not for HTTP wire format.

**Deviation (2026-05-11, paddle)**: Baidu retired the synchronous `/v2/ocr` endpoint used by `newspaper_ocr.py:_recognize_paddleocr`. M5 implements the **async jobs API** at `https://paddleocr.aistudio-app.com/api/v2/ocr/jobs` instead (docs: https://ai.baidu.com/ai-doc/AISTUDIO/fml7mozw5). Flow is `POST jobs` (multipart, returns `data.jobId`) → poll `GET jobs/{jobId}` until `data.state == "done"` → fetch `data.resultUrl.jsonUrl` (JSONL) and join non-empty `markdown.text`. Header is `Authorization: Bearer {token}`. New settings field `paddle_model` (default `PaddleOCR-VL-1.5`) selects between PP-OCRv5 / PP-StructureV3 / PaddleOCR-VL / PaddleOCR-VL-1.5. Retryable: HTTP 429/5xx + Baidu API codes 500 and 10010 (queue full).

### T5.1 [BE] · Secrets layer (`secrets.rs` via keyring)
- `src-tauri/src/secrets.rs`: `SecretKey` enum matching `ipc-types.ts`. `get(key) -> AppResult<Option<String>>`, `set(key, value)`, `delete(key)` via `keyring::Entry::new("local.kai.xcvt", key.as_str())`.
- `src-tauri/src/commands/settings.rs`: `get_secret(key) -> bool` (existence only — never return raw secret), `set_secret(key, value)`, `delete_secret(key)`.
- **Acceptance**: round-trip set→get on macOS Keychain; user prompted for first-time access; subsequent runs no prompt.
- ~~T5.1~~ (2026-05-11): `secrets.rs` with new `SecretKey { PaddleToken, OpenaiKey, OpenrouterKey, OpenaiCompatibleKey }`; commands wired in `lib.rs`. Frontend wrappers (`getSecret/setSecret/deleteSecret` in `src/lib/tauri.ts`) and `ipc-types.ts` aligned to the new lineup (claude_key dropped, openai_compatible_key added). Static gates green: `pnpm typecheck`, `pnpm build`, `cargo check`, `cargo clippy -- -D warnings`, `cargo test`. Manual Keychain round-trip remains for the UI loop when T5.5 lands.

### T5.2 [BE] · Non-secret settings (`config.rs` via tauri-plugin-store)
- `src-tauri/src/config.rs`: load/save `NonSecretSettings` via `tauri-plugin-store` at `${AppConfig}/settings.json`. Default values match Python `_OCR_PROMPT`, model defaults from `newspaper_ocr.py:309-311`.
- `get_settings()`, `set_settings(s)` commands.
- Mirror `src/store/settingsSlice.ts` to load/save through these commands.
- **Acceptance**: settings survive app restart; default prompt matches Python.
- ~~T5.2 (BE)~~ (2026-05-11): `config.rs` with `Provider`/`OcrProfile`/`NonSecretSettings` (serde snake_case), defaults sourced from `newspaper_ocr.py:296-311` (`_OCR_PROMPT`, `gpt-4o`, `google/gemini-2.5-flash-preview`). Persisted under key `settings` inside `${AppConfig}/settings.json` via `tauri-plugin-store`. `get_settings`/`set_settings` commands wired in `lib.rs`. Frontend `tauri.ts` wrappers already existed and remain compatible after the lineup change (M5 deviation). Slice expansion in `src/store/settingsSlice.ts` deferred to **T5.5** (settings dialog) — current slice still only owns `ocrProfile` until the dialog drives full hydrate/save. Static gates green.

### T5.3 [BE] · OcrProvider trait + 4 implementations
- `src-tauri/src/ocr/mod.rs`: `Provider` enum, `OcrProfile` constants (STANDARD/FAST), `#[async_trait] OcrProvider { recognize(&self, png_b64, prompt, ct) -> AppResult<String>; list_models(&self) -> AppResult<Vec<String>>; }`.
- `recognize_with_retry(provider, ...)`: retry loop over `[0, 2, 5]s` backoff on `429` and `5xx`. Cancellation token check between attempts.
- `paddle.rs`, `openai.rs`, `claude.rs`, `openrouter.rs`: implement trait. URL/headers/body shape **must match** `newspaper_ocr.py:359-478` byte-for-byte. Anthropic uses `anthropic-version: 2023-06-01`.
- `models.rs`: `fetch_provider_models(provider) -> Vec<String>` for OpenAI (`/v1/models`) + Claude (`/v1/models`).
- Tests: `wiremock` for each provider — happy path, 429-retry-success, fatal-4xx-error.
- **Acceptance**: `cargo test` covers all 4 providers; clippy clean.
- ~~T5.3 (paddle + openai)~~ (2026-05-11): `ocr/mod.rs` dispatches via enum match on `config::Provider`; `recognize_with_retry` implements the [0,2,5]s backoff over the same 3-attempt budget as Python (`OCREngine.MAX_RETRIES = 3`). `ocr/paddle.rs` mirrors `newspaper_ocr.py:_recognize_paddleocr` request shape (header `Authorization: token {tok}`, body `{file, fileType:1, ...}`) and joins `result.layoutParsingResults[].markdown.text` with `\n`. `ocr/openai.rs` implements OpenAI chat-completions vision (`{base_url}/chat/completions`, `Bearer {key}`, `image_url + text` content parts, `max_tokens: 4096`) plus `list_models` against `{base_url}/models` — the same module will back OpenRouter and the OpenAI-compatible custom endpoint by parameterising `base_url`. **Deviation**: enum dispatch + per-provider free fns instead of `dyn OcrProvider`; semantics and per-file layout match plan.md, only abstraction differs.
- ~~T5.3 (paddle async rewrite)~~ (2026-05-11, same day): switched `ocr/paddle.rs` from the soon-retired sync `/v2/ocr` endpoint to Baidu's async jobs API (POST→poll→fetch JSONL). See the paddle deviation note at the top of M5.
- ~~T5.3 (openrouter + openai_compatible + list_models)~~ (2026-05-11): wired the remaining two dispatch arms. `Provider::Openrouter` routes through `openai::recognize` with `OPENROUTER_BASE_URL = https://openrouter.ai/api/v1`; `Provider::OpenaiCompatible` reads `settings.openai_compatible_base_url` (Config error if empty). New `ocr::list_models(settings, secret)` backs T5.5's "刷新模型" button: paddle returns the static four-model catalogue (`PP-OCRv5 / PP-StructureV3 / PaddleOCR-VL / PaddleOCR-VL-1.5`), the OpenAI-family providers GET `{base_url}/models`.

Cargo tests pass (24 across 3 suites — paddle 8 + openai 6 + mod 5 + image 1 + pdf 4), clippy `-D warnings` clean. ~7s test wall time because `recognize_with_retry` honours real `[0, 2, 5]s` sleeps; a future T5.4 refactor can inject a `Clock`/`SleepFn` if this becomes painful.

### T5.4 [BE] · Job registry + cancellation
- `src-tauri/src/jobs/mod.rs`: `JobRegistry { by_id: HashMap<Uuid, JobHandle> }`, `JobHandle { token: CancellationToken, kind: JobKind }`. Stored in `AppState`.
- `src-tauri/src/jobs/grouped.rs`: spawn tokio task that iterates file-scoped articles → ordered block refs (`{ page, blockId, rect, order }`) → renders/caches the needed OCR bitmap for each page → crops bitmap → calls `OcrProvider::recognize` → emits `xcvt://job/progress` after each block, `xcvt://job/done` at end. Cancellation check between blocks.
- `src-tauri/src/commands/jobs.rs`: `cancel_job(job_id)`, `list_jobs()`.
- `src-tauri/src/commands/ocr.rs`: `start_grouped_ocr(req: GroupedOcrRequest) -> JobStarted`. Reads OCR-DPI bitmap per referenced page (re-render PDF page if needed), crops per block, dispatches.
- **Acceptance**: cancel mid-job stops within 1s; `tracing` shows clean shutdown.
- ~~T5.4~~ (2026-05-11): `jobs/mod.rs` (registry over `parking_lot::Mutex<HashMap<Uuid, JobHandle>>` + `tokio_util::sync::CancellationToken`), `jobs/grouped.rs` (request DTOs + worker), `commands/ocr.rs` (`start_grouped_ocr`, `cancel_job`, `list_jobs`, `list_provider_models`), `events.rs` (channel names mirrored to `src/lib/ipc-types.ts EVENTS`). Worker runs in two phases — phase 1 pre-renders every referenced page synchronously (PDFium is not `Send`, can't be held across `.await`), phase 2 is the async OCR loop that holds only Send data. Cancellation: token checked before each article + block; the OCR call itself races against `token.cancelled()` via `tokio::select!`. Image-file blocks: `scale = 1.0`, single load. PDF blocks: `scale = ocr_dpi / preview_dpi`, one render per unique page. `crop_block` clamps the user rect to the bitmap intersection and only errors on no-overlap. AppState gains `jobs: Arc<JobRegistry>`. Frontend: `ipc-types.ts` adds `GroupedOcrRequest / ArticleOcrPlan / BlockRef / JobListEntry / JobKind`; `tauri.ts` adds `startGroupedOcr / listProviderModels / cancelJob / listJobs`. Static gates green: 41 cargo tests (15 new in `jobs::*`), clippy `-D warnings` clean, `pnpm typecheck` + `pnpm build`. **Caveat**: each block waits up to ~7s of retry backoff before the cancellation token can interrupt the in-flight OCR call's sleep — exceeds plan.md's "within 1s" promise. Add cancellation-aware sleeps in `recognize_with_retry` if this becomes visible.

### T5.5 [UI+BE] · Settings dialog (4 provider tabs + custom prompt)
- `src/components/settings/SettingsDialog.tsx`: shadcn `Dialog` modal. Vertical Radix `Tabs` left rail (mockup `docs/mockups/settings.html`).
- `src/components/settings/ProviderPanel.tsx`: per-provider form. Props: `Provider` enum. Fields per provider as in Python `SettingsDialog._build_*_panel` (`newspaper_ocr.py:1363-1448`).
- "刷新模型" button calls `fetchProviderModels` and updates the model `<Select/>`.
- API key field: masked, with "显示 / 删除" buttons.
- Custom prompt textarea: bound to `settingsSlice.ocrPrompt`. "恢复默认" button.
- **Acceptance**: visual parity with mockup; provider switch preserves unsaved state per-tab; save persists secrets to keyring + non-secrets to store.
- ~~T5.5~~ (2026-05-11): `src/components/settings/SettingsDialog.tsx` (single file holds dialog frame + TabRail + ProviderPanel + PromptPanel; project still has no shadcn/radix install — built on plain Tailwind + lucide, matching M3 pattern). `settingsSlice` expanded to carry full `NonSecretSettings` + `DEFAULT_SETTINGS` mirror of the Rust defaults; legacy `ocrProfile` top-level mirror preserved for `ProfileToggle`. Entry points: `⌘,` global hotkey + gear button in the toolbar (rendered even on empty-queue first run). Draft state is dialog-local — Save writes via `setSettings` + per-key `setSecret`/`deleteSecret`; Cancel drops the draft. Backend `list_provider_models` gained optional `settings`/`secret` overrides so the 刷新 button can probe a draft (especially openai_compatible's base_url) before Save. API key fields never prefill (backend returns only a `bool`); placeholder explains the state. Dot badge in the tab rail reflects effective secret presence factoring in unsaved edits. Static gates green: pnpm typecheck + pnpm build + 42 vitest + 41 cargo tests + clippy `-D warnings`. **Visual review pending**: needs the human/Claude UI loop on `pnpm tauri dev` — screenshot pass against `docs/mockups/settings.html`.

### T5.6 [UI+BE] · ProgressDialog with cancel
- `src/components/progress/ProgressDialog.tsx`: shadcn `Dialog` non-closable on backdrop. Shows: total progress bar, "正在处理 报道N · 第K/M块", cancel button.
- Listens to `xcvt://job/progress`, `xcvt://job/done`, `xcvt://job/error`.
- Cancel → `cancelJob(jobId)`; status updates to "已取消".
- **Acceptance**: progress updates smoothly; cancel button takes effect within 1s.

### T5.7 [UI+BE] · "生成文档（OCR）" + result assembly + drawer
- Bottom status bar primary action: "识别选中报道". Avoid duplicating OCR actions in the right rail.
- On click: validate (≥1 file-scoped article, ≥1 block ref per article, provider configured) → `start_grouped_ocr({ file_id, path, ocr_dpi: profile.ocrDpi, articles: [{ id, title, num, blocks: [{ page, block_id, rect, order }] }], newspaper_name, newspaper_date })` → show ProgressDialog → on done event, write result to a file/document-level result store and slide up `<ResultDrawer/>`.
- Document assembly: port `_on_ocr_finished` (`newspaper_ocr.py:2532-2549`). Format: `{newspaper}\n{date}\n\n{title1}\n{body1}\n\n{title2}\n{body2}\n...`. Helper in `src/lib/format-doc.ts`. **Unit test** with fixture comparing byte-for-byte against the same Python output.
- `src/components/results/ResultDrawer.tsx`: bottom drawer (custom built on Radix Dialog primitive — can be `Sheet` with `side='bottom'`). Header shows summary + Copy/Save buttons. Body: per-file `<Tabs/>` with `<textarea/>` for each.
- **Acceptance**: mark 2 articles → 生成文档 → result matches Python verbatim.

### T5.8 [UI+BE] · Provider quick-switch in status bar
- Status bar text/control showing current provider + profile + model; click → small Radix `Popover` listing providers; pick one → updates settingsSlice.provider; saves to store.
- **Acceptance**: switch works without opening Settings; persists across restart.

### T5.9 · Verify M5 end-to-end
- Configure each of 4 providers with real API keys. Mark 2 articles. Run grouped OCR with each provider. Compare output to Python on same scan.
- Inject 429 via mock + retry test.
- Cancel mid-flight test.

---

## M6 — Full-page + batch OCR + folder import (4-5 days)

**Goal**: single-image full-page OCR; batch full-page across queue; batch grouped doc generation; folder recursive import with review modal; pause/resume; failed-item retry.

### T6.1 [BE] · `start_full_page_ocr` job
- `src-tauri/src/jobs/full_page.rs`: render full page → call provider → emit done. Single-task job, simpler than grouped.
- Command: `start_full_page_ocr(req: FullPageRequest) -> JobStarted`.
- **Acceptance**: image + PDF page both work; result lands in pageStates.resultText.

### T6.2 [BE] · `start_batch_full_page_ocr` job
- `src-tauri/src/jobs/batch_full_page.rs`: iterate `items: [{file_id, path, is_pdf, pdf_total}]`. For PDFs: each page is its own item. Concurrency limit 2 (configurable in settings — default `concurrent_provider_calls: 2`). Per-item events: `xcvt://job/item-done`, `xcvt://job/item-error`.
- **Crash recovery**: on each `item-done`, also write `${AppData}/sessions/<job_id>/<file_id>__<page>.md`. On app start, scan for stray sessions and offer "恢复" toast in status bar.
- **Acceptance**: 5-file batch (mix of PDFs + images) runs to completion; crash recovery test (kill mid-run, restart, see toast).

### T6.3 [BE] · `start_batch_grouped_doc` job
- `src-tauri/src/jobs/batch_grouped.rs`: per file with ≥1 article, run the grouped flow. Files with no articles: skip with `item-error { reason: "no articles marked" }`.
- **Acceptance**: 3-file batch with varying article counts produces 3 result texts in their respective tabs.

### T6.4 [BE] · Pause/resume token
- Replace `CancellationToken` with a custom `JobControl { paused: AtomicBool, cancelled: CancellationToken }`. Loop in jobs awaits `pause_check().await` between items, which idles until `paused == false` or cancelled.
- `pause_job(job_id)` / `resume_job(job_id)` commands.
- **Acceptance**: pause mid-batch → progress holds; resume → continues; total time = run time minus pause time (within 500ms).

### T6.5 [UI+BE] · Folder recursive import
- "添加文件夹" button → `dialog.open({ directory: true, multiple: false, recursive: false })` → backend command `scan_folder(path, max_depth: u32) -> Vec<ScanEntry>`. Filter to supported extensions; skip dot-directories and `Thumbs.db`/`.DS_Store`.
- If result count ≤ 20: add directly. If > 20: open `<BatchImportDialog/>` (mockup `docs/mockups/batch-import.html`).
- **Acceptance**: drop a 60-file folder → review dialog appears; uncheck-all/check-all/per-row toggle works; "导入 N 项" adds to queue with dedup.

### T6.6 [UI] · ProgressDialog dual-progress + retry-failed
- Extend ProgressDialog to two progress bars (total + current-file-pages) for batch jobs. Show last error inline. "重试失败项" button enabled when batch finishes with errors.
- **Acceptance**: simulate 1 of 5 files failing → "重试" reruns just that one.

### T6.7 [UI] · Batch buttons in queue panel
- Wire "批量整页 OCR" and "批量分组生成" footer buttons to `start_batch_full_page_ocr` and `start_batch_grouped_doc`.
- **Acceptance**: visual parity with mockup; only enabled when queue ≥ 1 file.

### T6.8 · Verify M6 end-to-end
- 5-file batch with mid-run pause-resume-cancel-retry. Crash recovery test. Folder import with 60 files including hidden subdirs.

---

## M7 — Export polish + release (3-4 days)

**Goal**: copy/save .txt|.md; command palette; release.yml produces 3 artifacts on tag push; clean-VM smoke test passes.

### T7.1 [UI+BE] · Copy + save buttons in result drawer
- Copy: `tauri-plugin-clipboard-manager` `writeText`. Status bar status flash "已复制 N 篇报道" 2s.
- Save: `tauri-plugin-dialog` `save({ filters: [{name: 'Markdown', extensions: ['md']}, {name: 'Text', extensions: ['txt']}] })` → `tauri-plugin-fs` `writeTextFile`. Default filename: `${newspaper}_${date}.md` (sanitized).
- **Acceptance**: both work on macOS + Windows.

### T7.2 [UI+BE] · ⌘K command palette
- `src/components/layout/CommandPalette.tsx`: shadcn `Command` (cmdk). Lists: every toolbar action, every queue file by name, every provider switch, "打开日志目录", "切换为浅色 / 深色模式".
- **Acceptance**: ⌘K opens palette; fuzzy search; Enter executes.

### T7.3 [BE] · Frontend log forwarding + open-log-dir
- Replace `tauri-plugin-log` setup in `lib.rs` with full `Target::new(TargetKind::LogDir { file_name: Some("app".into()) })`.
- Frontend `src/main.tsx`: `window.addEventListener('error', ...)` + `unhandledrejection` → `error()` from `@tauri-apps/plugin-log`.
- `open_log_dir()` command using `tauri-plugin-shell` `open()` on the log directory.
- **Acceptance**: error in dev shows up in `~/Library/Logs/local.kai.xcvt/app.log`; "打开日志目录" reveals in Finder/Explorer.

### T7.4 [BE] · CI release.yml — finalize pdfium fetch + arch matrix
- Update `release.yml` so the cache + fetch lines are unconditional (M2 stub TODO removed).
- Per-arch `tauri.conf.json` overrides via `TAURI_CONFIG` env or platform-specific config files (`tauri.macos-arm64.conf.json` etc.) — pdfium dylib path is arch-specific.
- Sign with ad-hoc identity (`-`). Documented upgrade path in `docs/SIGNING.md`.
- **Acceptance**: tag `v0.1.0-rc1` on a fork → 3 artifacts produced.

### T7.5 · Clean-VM acceptance test
- Install `Xcvt_*.dmg` on a VM running macOS arm64 (or Intel via Rosetta), and `Xcvt_*.msi` on Windows 11 VM.
- Walk through: drop a JPG, draw 3 blocks, mark as article, OCR with Claude, save .md. All without source-code reference.
- **Acceptance**: works first-run with documented `xattr -dr com.apple.quarantine` step on macOS, "More info → Run anyway" on Windows.

### T7.6 [UI] · Final visual polish
- Light-mode pass: every screen, every state, every modal.
- Empty states: queue empty, no articles, no result yet, no provider configured.
- Error states: failed file load, failed OCR, network down.
- **Acceptance**: 100% of mockup states reproduced; reduced-motion verified.

### T7.7 · Cut v0.1.0
- Update `package.json`, `Cargo.toml`, `tauri.conf.json` to `0.1.0`.
- Tag, push, verify release.yml produces all 3 artifacts.
- Update `README.md` with download links + first-run instructions.

---

## Maintenance

When adding tasks during implementation: append to this file, never delete. Mark completed tasks with a leading `~~T?.?~~` strikethrough rather than removing — gives the next agent (and the human) audit history.

When introducing a behavior the original Python doesn't have (e.g. crash recovery, pause/resume, command palette), document the deviation in [`docs/DESIGN.md`](./docs/DESIGN.md) "Open implementation questions" section so it surfaces in review.

When you hit something genuinely uncertain — a schema choice, a UX call, a performance trade-off — leave a code `// QUESTION:` comment AND note it under the milestone here. Don't silently improvise.
