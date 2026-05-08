# xcvt-tauri Implementation Plan

> **Status (M0 complete · 2026-05-08)**: project bootstrapped with Tauri 2 + React 18 + Vite + TypeScript + Tailwind + shadcn/ui scaffolding; design tokens + 3 mockups committed; `pnpm tauri dev` opens empty window; `pnpm typecheck` & `pnpm build` clean; `cargo check` clean. Authoritative design rationale in [`PRODUCT.md`](./PRODUCT.md) + [`DESIGN.md`](./DESIGN.md); implementation map in [`docs/DESIGN.md`](./docs/DESIGN.md); high-fidelity mockups in [`docs/mockups/*.html`](./docs/mockups/).
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

### T1.1 [BE] · Rust `image` crate + `load_raster_image` command
- Uncomment the `image = "0.25"` line in `src-tauri/Cargo.toml`.
- Create `src-tauri/src/image.rs` with `load_from_disk(path: &Path) -> AppResult<DynamicImage>` that handles PNG/JPEG/JPG/TIFF/TIF/BMP via `image::open`. Map errors to `AppError::Image(format!(...))`. Reject unsupported extensions with `AppError::FileNotFound` if file missing or `AppError::Image("unsupported format")` otherwise.
- Add `to_png_base64(img: &DynamicImage) -> AppResult<String>` using `image::ImageOutputFormat::Png` + `base64::engine::general_purpose::STANDARD`.
- Create `src-tauri/src/commands/mod.rs` and `src-tauri/src/commands/files.rs` with `#[tauri::command] async fn load_raster_image(path: String) -> AppResult<RenderedPagePayload>` returning `{ width, height, png_base64 }`. Mirror the DTO in `src/lib/ipc-types.ts` (already exists — verify match).
- Also add `#[tauri::command] async fn list_supported_extensions() -> Vec<&'static str>` returning `["png", "jpg", "jpeg", "tif", "tiff", "bmp"]`.
- Wire both commands into `src-tauri/src/lib.rs` `invoke_handler!`. Declare the `commands` module + `image` module.
- **Acceptance**: `cargo test` includes a unit test that loads a 64×64 fixture PNG (commit one to `src-tauri/tests/fixtures/sample.png`) and asserts `width == 64 && png_base64.starts_with("iVBORw0KGgo")`. `cargo clippy` clean.

### T1.2 [BE] · Frontend tauri.ts wrappers
- Add `loadRasterImage(path)` and `listSupportedExtensions()` to `src/lib/tauri.ts`. Types from `ipc-types.ts`.
- **Acceptance**: `pnpm typecheck` passes. The signature should match `src-tauri/src/commands/files.rs` exactly.

### T1.3 [UI] · AppShell layout (Toolbar + canvas region + StatusBar)
- Implement `src/components/layout/AppShell.tsx`: full-height flex column with `<Toolbar/>` (h-10), `<main class="flex-1 flex">` (canvas region), `<StatusBar/>` (h-7). Background `bg-background`, default `dark` class on `<html>` (already in `index.html`).
- `src/components/layout/Toolbar.tsx`: stub buttons matching mockup `docs/mockups/main.html` lines 95-160. M1 only needs: `Xcvt` brand chip, `添加文件` button (T1.6 wires it), zoom segmented control (renders only — T1.5 wires it), `⚙️` settings stub. Rest can be visible-but-disabled.
- `src/components/layout/StatusBar.tsx`: `就绪` indicator on left, `缩放 NN%` on right (T1.5 wires the value). Use `font-mono tabular-nums` for numbers.
- Replace the placeholder `src/App.tsx` with `<AppShell/>` rendering an empty `<ImageCanvas/>` (T1.4) in the canvas region.
- **Acceptance**: visual diff against `docs/mockups/main.html` toolbar+statusbar regions in dark mode. Heights, paddings, font sizes match mockup. **Must be reviewed by human/Claude before merging.**

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

### T1.7 [BE] · Store slices (queue + ui)
- `src/store/queueSlice.ts` (described above).
- `src/store/uiSlice.ts`: `zoomPercent: number (1..800)`, `setZoomPercent(p: number)`, `statusText: string`, `setStatusText(s: string)`. zoom updates from canvas wheel land here.
- `src/store/index.ts`: `useStore` combines both via zustand `create()`. **Avoid** a single mega-store — each slice file exports a typed creator; the combined store imports them.
- **Acceptance**: typecheck clean. No store mutations outside slice action functions.

### T1.8 [UI] · M1 visual polish pass
- Compare running app to `docs/mockups/main.html`. Adjust spacing, text sizes, hover states until parity. Pay attention to: toolbar h-10, statusbar h-7, font weights (500 on labels, 400 elsewhere), `tabular-nums` everywhere a number lives.
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

### T2.1 [BE] · pdfium binary fetch infrastructure
- Create `src-tauri/pdfium/VERSION` containing `chromium/6996` (or current latest from bblanchon — verify before pinning).
- Create `src-tauri/scripts/fetch_pdfium.sh` (bash) and `src-tauri/scripts/fetch_pdfium.ps1` (PowerShell). Each takes one arg: `macos-arm64 | macos-x64 | windows-x64`. Downloads matching tarball from `https://github.com/bblanchon/pdfium-binaries/releases/download/<VERSION>/pdfium-<arch>.tgz`, verifies SHA-256 against a checksum file, extracts `lib/libpdfium.dylib` or `bin/pdfium.dll` into `src-tauri/pdfium/<arch>/`.
- Maintain `src-tauri/pdfium/SHA256SUMS` with one line per arch.
- Update `.gitignore` (already done) and verify `src-tauri/pdfium/<arch>/*` patterns are ignored.
- Add `prepare:pdfium` npm script that runs the appropriate fetch script for the current host arch.
- **Acceptance**: `pnpm prepare:pdfium` on macOS arm64 populates `src-tauri/pdfium/macos-arm64/libpdfium.dylib` (>5 MB).

### T2.2 [BE] · Rust pdfium init + render_page command
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
- `src/components/queue/QueuePanel.tsx`: 220px-wide column on the left, mirroring `docs/mockups/main.html` lines 195-248. Header counts files; scrollable list of `<QueueItem/>`; footer with `添加`/`批量整页 OCR` (disabled in M2)/`批量分组生成` (disabled).
- `src/components/queue/QueueItem.tsx`: filename, ext icon (PDF vs image), page indicator `N / M` for PDFs, status icon (✓/⋯/!N). Active item gets the 2px primary stripe (`queue-item-active` from mockup).
- Click switches `currentFileId`; image canvas reloads.
- **Acceptance**: load a mix of PDF + images; click each — canvas updates within 500ms (preview render only); current page indicator updates.

### T2.4 [UI+BE] · PDF page navigation
- Toolbar prev/next buttons + page indicator (mockup lines 121-129). Wire to store: `prevPage()`/`nextPage()` clamp to `[1, pdfTotal]`.
- Hotkeys: `←` / `→` arrow keys.
- On page change: call `render_page(path, newPage, 150, "preview")` and update current file's payload. Cache rendered bitmaps in front-end LRU (T2.5).
- **Acceptance**: load a 5-page PDF; arrow keys navigate; page indicator updates; render <500ms per page.

### T2.5 [BE] · Frontend bitmap LRU cache
- `src/hooks/usePageBitmapCache.ts`: LRU keyed by `${fileId}::${page}::${dpi}`, capacity 12 preview entries. Stores `{blob: Blob, url: string}`. Evict on capacity → `URL.revokeObjectURL`.
- ImageCanvas reads from cache before requesting; falls back to `render_page` invocation, then writes back.
- Switch from base64 data URL (M1 simple path) to Blob+ObjectURL approach: build `Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], {type:'image/png'})` once on receipt; store URL.
- **Acceptance**: navigate 5-page PDF forward + backward — second visit to a page renders instantly (no network/IPC log).

### T2.6 [UI+BE] · Per-file state preservation across switch
- `src/store/pageStateSlice.ts`: `pageStates: Record<string, PageState>` keyed `${fileId}::${page}`. M2 tracks: `zoomPercent`, `panX`, `panY` per (file, page). M3 will add blocks/articles.
- Switching file: capture current pan/zoom into pageStates, restore the new file's pageStates.
- **Acceptance**: zoom into file A page 2 to 200%, switch to file B (zoom resets to fit), switch back to file A — page 2 still at 200% pan position.

### T2.7 [UI] · QueuePanel collapsed icon-rail mode
- Header chevron toggles `bg-surface` → 56px-wide rail showing only ext icons + status dot. Tooltip on hover shows filename. Persist collapsed state in `uiSlice`.
- **Acceptance**: collapse toggle works; tooltips legible; expand restores full panel.

### T2.8 · Verify M2 end-to-end (smoke gate)
- Load 3 files (1 PDF, 2 images). Switch between them. Navigate PDF pages. Collapse/expand queue. All states preserve correctly.
- Run on macOS arm64; **also build for x64 (Rosetta) and Windows** if possible — pdfium binary path resolution is the highest-risk piece.
- All commands clean; no clippy warnings.

---

## M3 — Block drawing & manipulation (4-5 days)

**Goal**: manual draw mode toggle; click-drag to create blocks; multi-select transformer; 8-handle resize; drag-move; selection-order labels; ⌘Z undo selection; Delete key; right-click delete on unassigned single block.

**Dependencies added**: none (Konva already in).

### T3.1 [BE] · Block + Article + Selection store slices
- `src/store/pageStateSlice.ts`: extend `PageState` with `blocks: Block[]`, `articles: Article[]`. `Block { id, x, y, w, h, articleId | null, articleOrder | null }`. `Article { id, num, title }`.
- `src/store/selectionSlice.ts`: `manualDrawMode: boolean`, `selectionOrder: string[]` (block ids). Actions: `toggleDrawMode()`, `pushSelection(id)`, `popSelection()`, `clearSelection()`, `removeFromSelection(id)`.
- All actions immer-mutate.
- **Acceptance**: typecheck clean. Unit tests for selection-order invariants under push/pop/remove.

### T3.2 [UI+BE] · Manual mode toggle in toolbar
- Wire toolbar "手动模式" button (mockup lines 137-141) to `toggleDrawMode()`. Active state shows the dot indicator + `bg-primary-muted`.
- **Acceptance**: toggle works visually; dot indicator reflects state.

### T3.3 [UI+BE] · `useDrawBlock` state machine
- `src/components/canvas/useDrawBlock.ts`: only active when `manualDrawMode === true`. State: `idle | drawing { startX, startY, currentX, currentY }`. Stage `mousedown` (not on existing block, not on transformer) → start. `mousemove` → update with rAF throttle. `mouseup` → if `|w|, |h| >= 16` (image coords) → dispatch `addBlock`; else discard. `Escape` cancels.
- `src/components/canvas/DrawingOverlay.tsx`: renders a dashed `<Rect/>` while drawing.
- **Acceptance**: with manual mode on, click-drag creates rectangle; <16px discarded; ESC cancels.

### T3.4 [UI+BE] · `BlockRect` rendering + hover/selected states
- `src/components/canvas/BlockRect.tsx`: Konva `<Rect/>` per block. Fill/stroke colors from `articleHsl(articleId)` helper (T3.7) at 22%/85% alpha, or `--primary` at 38%/100% alpha when selected.
- `mouseenter`/`mouseleave` toggles fill alpha to 32%.
- Click toggles selection (push/remove from `selectionOrder`).
- Stage click on empty area clears selection.
- **Acceptance**: draw 5 blocks; click cycles selection state; visual matches mockup `article-fill-N` styles.

### T3.5 [UI+BE] · `BlockLayer` with multi-select Transformer
- `src/components/canvas/BlockLayer.tsx`: layer holding all `BlockRect`s + a singleton `<Transformer/>` whose `nodes` are the currently selected refs. Set `keepRatio={false}`, 8 anchors (TL, T, TR, R, BR, B, BL, L), `rotateEnabled={false}`, `boundBoxFunc` enforcing min size 16×16.
- On `transformend`: read each child's resulting `x, y, scaleX*width, scaleY*height` and write back to store as new `{x, y, w, h}`. Reset `scaleX/Y` to 1 immediately.
- Drag-move: same flow via `onDragEnd` per block (or per-group via Transformer when multi-selected).
- **Acceptance**: multi-select 3 blocks → bounding box appears with 8 handles → drag corner scales all relative; drag body moves all together. Coords persisted to store, survive page-switch.

### T3.6 [UI+BE] · Selection-order labels
- `src/components/canvas/SelectionOrderLabel.tsx`: Konva `<Group>` containing a small filled `<Rect>` (background `--primary`) + `<Text>` showing `selectionOrder.indexOf(blockId) + 1`. Rendered only when block is in selectionOrder. Anchored at block's top-left + 4px inset.
- **Acceptance**: select 3 blocks in order; numbers 1, 2, 3 appear; deselect middle → 1, 2 reflow correctly.

### T3.7 [BE] · Article color token bridge
- `src/lib/article-color-token.ts`: `articleHsl(index, alpha = 1)` reads `--article-N` from `getComputedStyle(document.documentElement)` and returns `hsl(... / alpha)`. Cache result; invalidate on `MutationObserver` watching `<html>` class changes (theme switch).
- **Acceptance**: theme switch (set `document.documentElement.classList.toggle('dark')` from devtools) → block fills update without re-mount.

### T3.8 [UI+BE] · Keyboard shortcuts
- `src/components/canvas/useKeyboardShortcuts.ts`:
  - `⌘Z` (mac) / `Ctrl+Z` (win) → `popSelection()`.
  - `Del` / `Backspace` → delete all selected blocks (`removeBlock` for each id), clear selection. Show confirm only if >5 blocks selected.
  - Arrow keys nudge selected blocks 1px (image coords); `Shift+Arrow` nudges 8px.
- Right-click on a single unassigned block → context menu (Radix `ContextMenu`) with "删除版块". Right-click on assigned block → "解除报道分组" + "删除版块".
- **Acceptance**: all shortcuts work; arrow nudge feels smooth; context menu items respect block state.

### T3.9 [UI] · M3 visual polish + 200-block stress test
- Use a devtools snippet to populate 200 blocks; verify Konva FPS ≥ 55 during pan/zoom/select. If not: add `listening: false` on non-interactive layers; consider `cache()` on the BlockLayer.
- Polish hover/select transitions to 120ms ease-out-quart.
- **Acceptance**: stress test passes; visual review of all states (default, hover, selected, assigned-by-article-1..10).

### T3.10 · Verify M3 end-to-end
- Draw 5 blocks, multi-select, resize, drag-move, undo (⌘Z) selection, delete, navigate to another page (blocks persist on page A).

---

## M4 — Article grouping + metadata UI (2 days)

**Goal**: mark selected blocks as a named article; right-rail article list with rename/remove/clear-all; newspaper-name + date inputs; OCR profile toggle (standard/fast).

### T4.1 [UI+BE] · "Mark as article" workflow
- Right-rail `<BlockOpsPanel/>` (mockup lines 290-302): "标记为报道" button is enabled iff `selectionOrder.length >= 1`. On click: create `Article { id: uuid(), num: nextNum, title: \`报道${nextNum}\` }`, assign each selected block's `articleId = article.id` and `articleOrder = orderInSelection`. Clear selection. Re-color blocks.
- `nextNum` = max existing `num` + 1, scoped per (file, page).
- Hotkey `⌘G`.
- **Acceptance**: select 3 blocks → ⌘G → blocks turn article-1 colored, article appears in list.

### T4.2 [UI+BE] · Article list with rename/remove/clear-all
- `<ArticleList/>` (mockup lines 305-340): list of articles with badge (cycling `--article-N`), title, block count.
- Click row → highlights its blocks in canvas (transient ring stroke at `--accent`).
- Right-click row → context menu: "重命名" (inline text editor), "删除" (unassigns blocks, removes article), "解除分组并保留版块".
- "全清" button: confirm dialog ("确定清除全部 N 篇报道？") → reset all `articleId/articleOrder` to null and clear `articles[]`.
- Renumbering: when deleting article #2 of 4, remaining articles re-number to 1,2,3 and re-color.
- **Acceptance**: full CRUD on articles; visual state synced to canvas blocks.

### T4.3 [UI+BE] · MetadataInline + ProfileToggle
- `<MetadataInline/>` (mockup lines 274-287): two text inputs `报刊名` + `日期`. Bound to `pageStates[currentKey].newspaperName` / `.newspaperDate` (extend `PageState`).
- Note: per the mockup direction, metadata is *page-scoped*, not file-scoped. Re-confirm with human/Claude before committing — the Python original was file-scoped.
- `<ProfileToggle/>` in BlockOpsPanel: segmented toggle "标准 / 快速" bound to `settingsSlice.ocrProfile`.
- **Acceptance**: typing persists across page navigation; toggle changes profile (verifiable via store devtools).

### T4.4 · Verify M4 end-to-end
- Mark 5 articles in different colors. Rename, remove, clear all. Switch pages → metadata + articles persist. Visual matches mockup right-rail.

---

## M5 — OCR providers + grouped block OCR (5-6 days)

**Goal**: settings dialog with 4 provider panels + keychain integration; OcrProvider trait + retry; `start_grouped_ocr` job emitting progress events; ProgressDialog; document assembly. End-to-end: select articles → click "生成文档" → progress streams → result drawer fills.

**Dependencies added**: Rust `wiremock` already in dev-deps. No new runtime deps.

### T5.1 [BE] · Secrets layer (`secrets.rs` via keyring)
- `src-tauri/src/secrets.rs`: `SecretKey` enum matching `ipc-types.ts`. `get(key) -> AppResult<Option<String>>`, `set(key, value)`, `delete(key)` via `keyring::Entry::new("local.kai.xcvt", key.as_str())`.
- `src-tauri/src/commands/settings.rs`: `get_secret(key) -> bool` (existence only — never return raw secret), `set_secret(key, value)`, `delete_secret(key)`.
- **Acceptance**: round-trip set→get on macOS Keychain; user prompted for first-time access; subsequent runs no prompt.

### T5.2 [BE] · Non-secret settings (`config.rs` via tauri-plugin-store)
- `src-tauri/src/config.rs`: load/save `NonSecretSettings` via `tauri-plugin-store` at `${AppConfig}/settings.json`. Default values match Python `_OCR_PROMPT`, model defaults from `newspaper_ocr.py:309-311`.
- `get_settings()`, `set_settings(s)` commands.
- Mirror `src/store/settingsSlice.ts` to load/save through these commands.
- **Acceptance**: settings survive app restart; default prompt matches Python.

### T5.3 [BE] · OcrProvider trait + 4 implementations
- `src-tauri/src/ocr/mod.rs`: `Provider` enum, `OcrProfile` constants (STANDARD/FAST), `#[async_trait] OcrProvider { recognize(&self, png_b64, prompt, ct) -> AppResult<String>; list_models(&self) -> AppResult<Vec<String>>; }`.
- `recognize_with_retry(provider, ...)`: retry loop over `[0, 2, 5]s` backoff on `429` and `5xx`. Cancellation token check between attempts.
- `paddle.rs`, `openai.rs`, `claude.rs`, `openrouter.rs`: implement trait. URL/headers/body shape **must match** `newspaper_ocr.py:359-478` byte-for-byte. Anthropic uses `anthropic-version: 2023-06-01`.
- `models.rs`: `fetch_provider_models(provider) -> Vec<String>` for OpenAI (`/v1/models`) + Claude (`/v1/models`).
- Tests: `wiremock` for each provider — happy path, 429-retry-success, fatal-4xx-error.
- **Acceptance**: `cargo test` covers all 4 providers; clippy clean.

### T5.4 [BE] · Job registry + cancellation
- `src-tauri/src/jobs/mod.rs`: `JobRegistry { by_id: HashMap<Uuid, JobHandle> }`, `JobHandle { token: CancellationToken, kind: JobKind }`. Stored in `AppState`.
- `src-tauri/src/jobs/grouped.rs`: spawn tokio task that iterates articles → blocks → crops bitmap → calls `OcrProvider::recognize` → emits `xcvt://job/progress` after each block, `xcvt://job/done` at end. Cancellation check between blocks.
- `src-tauri/src/commands/jobs.rs`: `cancel_job(job_id)`, `list_jobs()`.
- `src-tauri/src/commands/ocr.rs`: `start_grouped_ocr(req: GroupedOcrRequest) -> JobStarted`. Reads OCR-DPI bitmap (re-render PDF page if needed), crops per block, dispatches.
- **Acceptance**: cancel mid-job stops within 1s; `tracing` shows clean shutdown.

### T5.5 [UI+BE] · Settings dialog (4 provider tabs + custom prompt)
- `src/components/settings/SettingsDialog.tsx`: shadcn `Dialog` modal. Vertical Radix `Tabs` left rail (mockup `docs/mockups/settings.html`).
- `src/components/settings/ProviderPanel.tsx`: per-provider form. Props: `Provider` enum. Fields per provider as in Python `SettingsDialog._build_*_panel` (`newspaper_ocr.py:1363-1448`).
- "刷新模型" button calls `fetchProviderModels` and updates the model `<Select/>`.
- API key field: masked, with "显示 / 删除" buttons.
- Custom prompt textarea: bound to `settingsSlice.ocrPrompt`. "恢复默认" button.
- **Acceptance**: visual parity with mockup; provider switch preserves unsaved state per-tab; save persists secrets to keyring + non-secrets to store.

### T5.6 [UI+BE] · ProgressDialog with cancel
- `src/components/progress/ProgressDialog.tsx`: shadcn `Dialog` non-closable on backdrop. Shows: total progress bar, "正在处理 报道N · 第K/M块", cancel button.
- Listens to `xcvt://job/progress`, `xcvt://job/done`, `xcvt://job/error`.
- Cancel → `cancelJob(jobId)`; status updates to "已取消".
- **Acceptance**: progress updates smoothly; cancel button takes effect within 1s.

### T5.7 [UI+BE] · "生成文档（OCR）" + result assembly + drawer
- `<GenerateActions/>` (mockup lines 376-385): "生成文档（OCR）" primary button, "整页识别" secondary.
- On click: validate (≥1 article, ≥1 block per article, provider configured) → `start_grouped_ocr({ file_id, path, page, ocr_dpi: profile.ocrDpi, articles, newspaper_name, newspaper_date })` → show ProgressDialog → on done event, write to `pageStates[key].resultText` and slide up `<ResultDrawer/>`.
- Document assembly: port `_on_ocr_finished` (`newspaper_ocr.py:2532-2549`). Format: `{newspaper}\n{date}\n\n{title1}\n{body1}\n\n{title2}\n{body2}\n...`. Helper in `src/lib/format-doc.ts`. **Unit test** with fixture comparing byte-for-byte against the same Python output.
- `src/components/results/ResultDrawer.tsx`: bottom drawer (custom built on Radix Dialog primitive — can be `Sheet` with `side='bottom'`). Header shows summary + Copy/Save buttons. Body: per-file `<Tabs/>` with `<textarea/>` for each.
- **Acceptance**: mark 2 articles → 生成文档 → result matches Python verbatim.

### T5.8 [UI+BE] · Provider quick-switch in status bar
- Status bar segment showing current provider + model (mockup line 543); click → small Radix `Popover` listing providers; pick one → updates settingsSlice.provider; saves to store.
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
