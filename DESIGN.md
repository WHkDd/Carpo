# DESIGN — Xcvt

Concrete design system for xcvt-tauri. Tokens are CSS variables driven by HSL→OKLCH-derived neutrals warmed toward archival paper. Dark mode is the primary surface; light mode is supported but tuned for daytime reading rather than first-impression marketing.

## Scene sentence

PhD historian, 11pm, dim apartment study with one warm lamp behind the monitor, third hour of marking 字林西报 articles on 60 pages of newspaper scans, planning to leave a batch OCR job running overnight while sleeping. The interface should feel like a focused IDE next to a tea cup, not a SaaS analytics tool.

That sentence forces the answers below. Don't change the answers without rewriting the scene.

## Color strategy: Restrained

Tinted neutrals warmed slightly toward `oklch(0.~ 0.005 60)` (paper / ink hues). Single accent: a deep terracotta-red, picked for two reasons — (1) it's the natural color of seal-stamps and emphasis marks in Chinese archival contexts, (2) it's far enough from SaaS-blue and crypto-green to escape both reflexes. Article colors keep their 10-hue palette for grouping clarity, but they're rendered at low saturation in the chrome and high saturation only when they're the user's selection.

| Token | Dark (default) | Light | Notes |
|---|---|---|---|
| `--background` | `#1a1715` | `#f7f3ed` | warm dark / paper cream |
| `--surface` | `#211d1a` | `#fbf8f3` | sidebars, command palette body |
| `--surface-2` | `#2a2521` | `#efeae1` | toolbars, popovers |
| `--surface-overlay` | `#332d28` | `#e7e0d4` | elevated cards, drawer |
| `--foreground` | `#e8e1d6` | `#231f1c` | primary text |
| `--foreground-muted` | `#a59c8e` | `#6b6359` | secondary text |
| `--foreground-subtle` | `#736b60` | `#8e8678` | tertiary text |
| `--border` | `#352e29` | `#dcd5c8` | hairlines |
| `--border-strong` | `#473e37` | `#c5bdae` | input focus, divider |
| `--accent` | `#d05f3c` | `#b54a28` | primary actions, selection |
| `--accent-foreground` | `#1a1715` | `#fbf8f3` | text on accent |
| `--accent-muted` | `#3a2620` | `#f3d8cb` | accent background tints |
| `--success` | `#7fa86a` | `#5a8347` | OCR done, valid keys |
| `--warning` | `#c89a3f` | `#a07a25` | retries, rate limits |
| `--destructive` | `#c25245` | `#9f3327` | errors, delete |
| `--ring` | `#d05f3c` | `#b54a28` | focus outlines |

**Article hues** (10 distinct, used for marked-block fills/strokes; same OKLCH targets across themes — chroma drops 30% in light mode to keep them readable on cream paper):
1. terracotta `oklch(0.66 0.16 35)` · 2. moss `oklch(0.62 0.13 130)` · 3. plum `oklch(0.55 0.14 320)` · 4. lake `oklch(0.62 0.12 220)` · 5. amber `oklch(0.72 0.16 75)` · 6. magenta `oklch(0.62 0.18 0)` · 7. cobalt `oklch(0.55 0.16 260)` · 8. clay `oklch(0.5 0.08 50)` · 9. iris `oklch(0.6 0.16 290)` · 10. teal `oklch(0.58 0.11 190)`

Block fills render at 22% alpha against the canvas; strokes at 85% alpha at 1.5px. Selected blocks override fill to 38% alpha and lift stroke to 2.5px in `--accent`.

## Typography

Single sans family — system stack with Chinese-aware fallback first:

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

Weights: 400 (body), 500 (UI labels, buttons), 600 (titles, emphasis). Avoid 700 — too heavy on dense panels. Set `font-feature-settings: "ss01", "cv02", "tnum", "calt"` on `body` for Inter; `tnum` on every numeric label.

## Spacing & rhythm

4px grid. Use 6, 8, 12, 16, 24, 32 for containers; 2, 4 for tight controls. Splitter gutters are exactly 1px — no fat dividers. Toolbar height: 40px. Status bar: 28px. Right workspace expanded: 320px (rooted in 16px logical units × 20). Left queue expanded: 220px. Both collapse to 56px (icon rail).

## Elevation

| Layer | Shadow | Use |
|---|---|---|
| 0 | — | canvas, panels, anything backed by `--surface` directly |
| 1 | `0 1px 0 hsl(var(--border))` | toolbar bottom, status top, queue right edge — flat dividers, not glow |
| 2 | `0 8px 24px -12px hsl(0 0% 0% / 0.45)` | result drawer raised, popover |
| 3 | `0 20px 60px -20px hsl(0 0% 0% / 0.55)` | modals (settings, batch import review) |

No glassmorphism, no inner glow, no gradient borders. Border-radius: 6px (controls, cards), 10px (modals, drawer), 999px (segmented toggles). Side-stripe accents are banned per impeccable shared laws.

## Information architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Toolbar — 40px                                                          │
│  ◀ Xcvt   |  ⨁ 添加  ⌗ 文件夹  |  ⤺ 上一页 / 下一页  |  缩放 — | 100% | + │
│                                            |  🔍 ⌘K  |  ⚙️                │
├──────┬──────────────────────────────────────────┬───────────────────────┤
│      │                                          │ Workspace · 320px     │
│ File │                                          │ ── 元数据             │
│ Queue│                                          │ 报刊：              │
│ rail │                                          │ 日期：              │
│ 220px│         CANVAS — Konva stage             │                       │
│ — or │         · pan/zoom 1-800%                │ ── 选区 (3 块)        │
│ 56px │         · click-drag to draw             │ [标记为报道]          │
│ icons│         · multi-select transformer       │                       │
│      │         · 8-handle resize                │ ── 报道 (5)           │
│      │         · article-color fills            │ ① 头版社论            │
│      │         · selection-order badges         │ ② 商业新闻            │
│      │                                          │ ③ ...                 │
│      │                                          │                       │
│      │                                          │ ── OCR                │
│      │                                          │ Provider: Claude      │
│      │                                          │ Profile: Standard     │
│      │                                          │ [生成文档]            │
│      │                                          │ [整页识别]            │
├──────┴──────────────────────────────────────────┴───────────────────────┤
│ Result drawer (collapsed by default, slides up over the workspace+canvas)│
│ ▲ 时事新报 · 民国三十六年四月六日 · 5 篇 · 复制 · 保存 .md               │
├─────────────────────────────────────────────────────────────────────────┤
│ Status — 28px                                                           │
│  ● 就绪 · Claude · standard · 选中 3 块 · 报道 5 / 8 · 缩放 100%        │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key shifts from the old PySide6 layout**:
- Right panel is task-aware. When the user is marking blocks: shows selection actions + article list. When OCR has completed: dims and lets the result drawer take focus. When in batch mode: switches to batch overview.
- Result text moved to a bottom drawer. The canvas is the long axis; the user reads results horizontally, not in a 360px column.
- File queue can collapse to icon thumbnails. Most users won't need filenames once they're 3 hours in.
- Settings is a dedicated modal with provider sub-pages (Radix Tabs vertical), not a stacked dialog.

## State vocabulary

Every interactive element ships with: `default · hover · focus-visible · active · selected · disabled · loading · error`. Standardized:

- **Hover**: shift `background` to `--surface-2`, no scale, no shadow.
- **Focus-visible**: 2px `--ring` outline, 2px offset, never the default browser glow.
- **Active**: invert to `--accent` background + `--accent-foreground` text for primary actions; `--surface-overlay` background for secondary.
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
- `BlockOverlay` — Konva-rendered, not DOM
- `SelectionOrderBadge` — Konva text node
- `BatchProgressDialog` — dual-progress with retry-failed
- `FileQueueRail` — collapsible with drag-to-resize

## Microinteractions

- **Drawer toggle**: 200ms ease-out-quart, transform: translateY only (no layout animation). Drawer state persists per-file.
- **Block draw**: 0ms — feels direct. Dashed stroke during drag, solid on commit.
- **Selection transformer attach**: 120ms fade-in of handles; no scale-in (handles snapping to position is visual jitter).
- **Article color assignment**: 180ms cross-fade between "selected/orange" and the article's hue.
- **Progress dialog appear**: 220ms fade + 4px translate-up. No backdrop blur.
- **Toast / status messages**: text-only updates in the status bar — no toasts in the corner. The status bar IS the feedback channel.
- **⌘K palette**: 100ms scale-in (0.96 → 1.0) + opacity. cmdk default keyboard behavior.

## Accessibility floor

- Min contrast: WCAG AA (4.5:1 body, 3:1 large text) verified for both themes against `--background` and `--surface`. Article-hue strokes at 85% alpha hit 3:1 against `--background` — verified via OKLCH lightness tuning.
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
3. Article colors: shuffle hue assignment per session for visual variety, or keep stable assignment (article 1 = terracotta always)? Current bias: stable. Less surprise.
4. Light mode at all? It costs implementation budget. Current bias: yes, but ship it as a "Day mode" toggle in command palette only, not a prominent feature.
