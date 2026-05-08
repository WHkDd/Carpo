# DESIGN — Xcvt

Concrete design system for xcvt-tauri. Tokens are CSS variables driven by HSL from near-neutral OKLCH values. The current direction is light, restrained, and monochrome: white carries the app chrome, a single pale gray field carries the newspaper reading canvas, and graphite carries emphasis. Color appears only as functional annotation or semantic state. There is no dark theme in the default product direction.

## Scene sentence

PhD historian, late evening, desk lamp on, scanning and marking 字林西报 pages on a bright external monitor. The interface should feel like a precise monochrome desktop tool: closer to a well-made native document inspector than a dark editor, dashboard, or nostalgic archive cabinet.

That sentence forces the answers below. Don't change the answers without rewriting the scene.

## Color strategy: Restrained

Near-white surfaces do most of the work. The center newspaper canvas is the only broad gray plane, so the scan can sit on a stable reading field without making the whole app feel gray. Primary actions and focus states use graphite black rather than a colored accent. Hover and selected states are expressed through value shifts, borders, and weight. Article colors keep a low-chroma 10-hue palette only because grouping rectangles needs more than grayscale; those hues stay inside the canvas and article badges, not in the chrome.

| Token | Light default | Notes |
|---|---|---|
| `--background` | `#fbfbfa` | app background and chrome |
| `--surface` | `#fbfbfa` | sidebars, toolbar, right panel, status bar |
| `--surface-2` | `#f0f1f2` | hover states, active rows, soft utility controls |
| `--surface-overlay` | `#e7e8ea` | popovers, drawer, raised panels |
| `--canvas` | `#ebedf0` | the only broad gray field, behind newspaper scans |
| `--foreground` | `#181818` | primary text |
| `--foreground-muted` | `#5f5f5c` | secondary text |
| `--foreground-subtle` | `#858580` | tertiary text |
| `--border` | `#d9d9d6` | hairlines |
| `--border-strong` | `#b9b9b4` | input focus, stronger dividers |
| `--accent` | `#262626` | primary actions, focus, current selection |
| `--accent-foreground` | `#f7f7f6` | text on accent |
| `--accent-muted` | `#e8e8e6` | subdued selected backgrounds |
| `--success` | `#5f7664` | OCR done, valid keys |
| `--warning` | `#8a7444` | retries, rate limits |
| `--destructive` | `#9d4f49` | errors, delete |
| `--ring` | `#262626` | focus outlines |

**Article hues** (10 distinct, used only for marked-block fills/strokes and small article badges):
1. blue gray `oklch(0.58 0.06 245)` · 2. green gray `oklch(0.56 0.05 150)` · 3. violet gray `oklch(0.56 0.06 300)` · 4. cyan gray `oklch(0.58 0.05 205)` · 5. ochre gray `oklch(0.6 0.06 85)` · 6. rust gray `oklch(0.58 0.06 35)` · 7. indigo gray `oklch(0.56 0.06 265)` · 8. olive gray `oklch(0.55 0.04 120)` · 9. plum gray `oklch(0.56 0.05 325)` · 10. teal gray `oklch(0.56 0.05 185)`

Block fills render at 22% alpha against the canvas; strokes at 85% alpha at 1.5px. Selected blocks override fill to 38% alpha and lift stroke to 2.5px in `--accent`.

## Typography

Single sans family, system stack with Chinese-aware fallback first:

```css
--font-sans: "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont,
             "Segoe UI Variable", "Segoe UI", "Inter Variable", Inter, system-ui, sans-serif;
--font-mono: "JetBrains Mono", "SF Mono", ui-monospace, "Cascadia Code",
             Menlo, Consolas, monospace;
```

Fixed rem scale (1.125 ratio):

| Token | rem | px | Use |
|---|---|---|---|
| `--text-xs` | 0.6875 | 11 | tabular numerals, badge labels |
| `--text-sm` | 0.8125 | 13 | UI body, button text, table cells |
| `--text-base` | 0.9375 | 15 | result drawer body, input |
| `--text-lg` | 1.0625 | 17 | dialog titles, focus headings |
| `--text-xl` | 1.25 | 20 | rare; only result drawer headings |

Weights: 400 (body), 500 (UI labels, buttons), 600 (titles, emphasis). Avoid 700 because it is too heavy on dense panels. Set `font-feature-settings: "ss01", "cv02", "tnum", "calt"` on `body` for Inter; `tnum` on every numeric label.

## Spacing & rhythm

4px grid. Use 6, 8, 12, 16, 24, 32 for containers; 2, 4 for tight controls. Splitter gutters are reserved for real resizing only; do not draw decorative vertical separators between primary columns. Top status bar height: 48px. Canvas tool strip: 46px. Bottom status bar: 38px. Right text-structure rail: 320px. Left queue rail: 250px.

## Elevation

| Layer | Shadow | Use |
|---|---|---|
| 0 | — | canvas, panels, anything backed by `--surface` directly |
| 1 | `0 1px 0 hsl(var(--border))` | toolbar bottom, status top, queue right edge, flat dividers |
| 2 | `0 8px 24px -12px hsl(0 0% 0% / 0.45)` | result drawer raised, popover |
| 3 | `0 20px 60px -20px hsl(0 0% 0% / 0.55)` | modals (settings, batch import review) |

No glassmorphism, no inner glow, no gradient borders. Border-radius: 6px (controls), 8px (queue rows and structure rows), 10px (modals, drawer), 999px (segmented toggles). Keep structural divider lines sparse: no hard divider between the left queue and canvas, and no hard divider before the right inspector unless the real component needs resizing. Side-stripe accents are banned per impeccable shared laws.

## Information architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Left queue · 250px │ Top status · document title + page nav + ready       │
│                    ├──────────────────────────┬───────────────────────────┤
│ macOS controls     │ Canvas tools             │ Text structure · 304px    │
│ no app name        │ · mark/select modes      │ · page structure summary  │
│                    │                          │ · article/block outline   │
│ scan queue         │ Gray canvas field         │ · reading order           │
│ active file row    │   newspaper scan          │ · selected block note     │
│                    │   Konva block overlays   │                           │
│                    │                          │                           │
├────────────────────┴──────────────────────────┴───────────────────────────┤
│ Bottom status · OCR provider/profile/model · zoom · progress · primary OCR │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key shifts from the old PySide6 layout**:
- Right panel is a scanned-text structure inspector, not a generic workspace. Avoid card-like metric blocks and avoid repeating structure actions as a button pile. OCR provider/profile belongs to the bottom status bar.
- The center gray canvas is the dominant reading surface. Everything around it stays near-white so the canvas is the only broad gray area.
- Repeated controls are avoided: zoom lives in the bottom bar, OCR execution lives in the bottom bar, structure editing is contextual inside the right rail, page navigation lives in the top status bar.
- The top-left title area stays blank after the macOS traffic controls. Do not put the app name or logo there.
- File queue can collapse to icon thumbnails. Most users won't need filenames once they're 3 hours in.
- Settings is a dedicated modal with provider sub-pages (Radix Tabs vertical), not a stacked dialog.

## State vocabulary

Every interactive element ships with: `default · hover · focus-visible · active · selected · disabled · loading · error`. Standardized:

- **Hover**: shift `background` to `--surface-2`, no scale, no shadow.
- **Focus-visible**: 2px `--ring` outline, 2px offset, never the default browser glow.
- **Active**: invert to `--accent` background + `--accent-foreground` text for primary actions; use `--surface-overlay` background for secondary.
- **Selected** (toggles, queue items): left edge gets a 2px `--accent` indicator (this is *intentional* — exempt from the side-stripe ban because it's a state cue, not a decorative accent on a card).
- **Disabled**: 40% foreground opacity, no hover response.
- **Loading**: shadcn Skeleton or pulsing `--surface-2` background. Never centered spinners over content.
- **Error**: 1px `--destructive` border + 12px `--destructive` icon at left of label.

## Components (shadcn/ui)

Install / generate (M0 → M5):
- `Button` (variants: default, destructive, outline, secondary, ghost, link; sizes: sm, default, lg, icon)
- `Input`, `Textarea`, `Label`
- `Dialog` (settings, batch import review)
- `Sheet` / drawer pattern for the bottom result drawer (custom built on Radix Sheet primitive — shadcn Sheet is side-only by default; we use bottom)
- `Tabs` (settings provider switching, vertical orientation)
- `Select` (provider chooser, model dropdown)
- `Tooltip` (toolbar buttons)
- `Command` (⌘K palette via cmdk)
- `Popover` (provider quick-switch in toolbar)
- `Progress` (linear, used in dual-progress)
- `Toggle` / `ToggleGroup` (manual-mode switch, OCR profile)
- `ScrollArea` (queue, article list, result drawer body)
- `Separator`
- `ContextMenu` (right-click on blocks)
- `DropdownMenu` (file-menu fallback)
- `AlertDialog` (destructive confirms: clear-all, delete-article)

Custom (no shadcn equivalent):
- `BlockOverlay`: Konva-rendered, not DOM
- `SelectionOrderBadge`: Konva text node
- `BatchProgressDialog`: dual-progress with retry-failed
- `FileQueueRail`: collapsible with drag-to-resize

## Microinteractions

- **Drawer toggle**: 200ms ease-out-quart, transform: translateY only (no layout animation). Drawer state persists per-file.
- **Block draw**: 0ms, feels direct. Dashed stroke during drag, solid on commit.
- **Selection transformer attach**: 120ms fade-in of handles; no scale-in (handles snapping to position is visual jitter).
- **Article color assignment**: 180ms cross-fade between "selected/orange" and the article's hue.
- **Progress dialog appear**: 220ms fade + 4px translate-up. No backdrop blur.
- **Toast / status messages**: text-only updates in the status bar. No toasts in the corner. The status bar is the feedback channel.
- **⌘K palette**: 100ms scale-in (0.96 → 1.0) + opacity. cmdk default keyboard behavior.

## Accessibility floor

- Min contrast: WCAG AA (4.5:1 body, 3:1 large text) verified for both themes against `--background` and `--surface`. Article-hue strokes at 85% alpha hit 3:1 against `--background`, verified via OKLCH lightness tuning.
- Focus-visible rings on every interactive element. No `outline: none` without a replacement.
- Keyboard equivalents for every mouse-only action. Arrow keys nudge selected blocks 1px; shift+arrow nudges 8px.
- Screen reader labels on all icon-only buttons. Tooltip text is duplicated to `aria-label`.
- Respect `prefers-reduced-motion`: drawer slide collapses to 0ms, palette skips scale-in.

## Implementation notes

- Ship CSS variables in HSL form for shadcn compatibility, but pick values via OKLCH first then convert. Document the OKLCH source in comments next to each declaration.
- Tailwind: extend with the custom `surface`, `surface-2`, `surface-overlay`, `foreground-muted`, `foreground-subtle`, plus `article-1` through `article-10` and `accent-muted`. The current generated `tailwind.config.ts` covers a subset; extend in M0.
- Konva: pan/zoom on `Stage`, blocks in a single non-listening fast layer with rect-level event listeners. Transformer is a singleton attached to the active multi-selection.
- Mockups in `/docs/mockups/*.html` use Tailwind CDN and inline tokens for portable preview. Production code re-uses the same token names from `src/styles/globals.css`.

## Open questions for M0 review

1. Should the result drawer be peek-able (24px lip always visible) or fully hidden until first OCR? Current bias: hidden until first OCR completes for that file, then peek-able.
2. Should Provider switching live in the toolbar or only in Settings? Current bias: status-bar segmented toggle for quick switch; Settings owns the long-tail model + prompt config.
3. Article colors: shuffle hue assignment per session for visual variety, or keep stable assignment (article 1 = blue gray always)? Current bias: stable. Less surprise.
4. Keep any optional dim mode? Current bias: no. Ship the light monochrome interface first.
