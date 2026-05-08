# Design implementation guide

This file is for implementers walking through the source. The root [`DESIGN.md`](../DESIGN.md) holds the design system rationale; this one maps that system onto specific files, components, and shadcn primitives.

For high-fidelity static previews open the mockups directly in any browser:
- [`mockups/xcvt-scan-structure-preview.html`](mockups/xcvt-scan-structure-preview.html) — approved primary working surface
- [`mockups/batch-import.html`](mockups/batch-import.html) — folder import review modal
- [`mockups/settings.html`](mockups/settings.html) — settings dialog (Claude tab shown)

## File-to-section map

| Mockup region | Implementation files | shadcn / lib |
|---|---|---|
| Top status bar | `src/components/layout/Toolbar.tsx` | document status + page navigation only |
| File queue rail | `src/components/queue/{QueuePanel,QueueItem}.tsx` | `ScrollArea`, active queue row without a left divider |
| Canvas | `src/components/canvas/{ImageCanvas,BlockLayer,BlockRect,DrawingOverlay,SelectionOrderLabel}.tsx` | Konva (no shadcn), gray backing surface |
| Text structure rail | `src/components/workspace/{StructurePanel,ReadingOrder,BlockOpsPanel}.tsx` | outline rows, reading order, selected block note |
| Result drawer (bottom) | `src/components/results/ResultDrawer.tsx` + `ResultEditor.tsx` | Custom drawer (Radix Sheet primitive bottom variant), `Tabs` for per-file |
| Settings modal | `src/components/settings/{SettingsDialog,ProviderPanel}.tsx` | `Dialog`, `Tabs` (vertical), `Input`, `Textarea`, `Select` |
| Progress dialog | `src/components/progress/ProgressDialog.tsx` | `Dialog`, `Progress` |
| Batch import review | `src/components/queue/BatchImportDialog.tsx` | `Dialog`, `ScrollArea`, `Checkbox`, `Input`, custom row |
| Status bar | `src/components/layout/StatusBar.tsx` | OCR provider/profile/model, zoom, progress text, primary OCR action |
| Command palette | `src/components/layout/CommandPalette.tsx` | shadcn `Command` (cmdk) |

## Token usage cheatsheet

Every surface picks one of:
- `bg-background` — app shell and near-white chrome
- `bg-surface` — panels, top status bar, status bar, file queue, text structure rail
- `bg-canvas` — the only broad gray field, behind the newspaper scan
- `bg-surface-2` — toggle group backgrounds, hover states, queue active row
- `bg-surface-overlay` — popovers, command palette, drawer raised state, kbd backgrounds
- `bg-card` — alias for `bg-surface`; prefer `bg-surface` directly

Text:
- `text-foreground` — primary content
- `text-foreground-muted` — labels, secondary metadata, help text
- `text-foreground-subtle` — counts, dividers as text, fine print

Borders: use `border-border` inside controls and active rows, but keep major structural dividers sparse. The approved shell has no hard vertical line between the left queue and the center canvas, and no hard vertical line before the right structure rail. Use `border-border-strong` for the scan page edge, input focus, or a real resizable splitter.

Accent: `bg-primary text-primary-foreground` for the **one** primary action per surface, currently the bottom-bar "识别选中报道" action. The current accent is graphite black, not a color accent. Other actions are `border border-border bg-surface` (outline) or `text-foreground-muted hover:bg-surface-2` (ghost).

Selection / state stripe: `position: relative; ::before { left: 0; top/bottom: 6px; width: 2px; background: hsl(var(--primary)); }`. Used on `queue-item-active` and `tab.active`. This is the **only** sanctioned use of side accents per the impeccable shared bans because it is a state cue, not decoration on a card.

## Konva → DOM bridge

Konva renders into a `<canvas>` and doesn't honor CSS variables directly. Helper:

```ts
// src/lib/article-color-token.ts
export function articleHsl(index: number, alpha = 1): string {
  const root = getComputedStyle(document.documentElement);
  const hsl = root.getPropertyValue(`--article-${(index % 10) + 1}`).trim();
  return `hsl(${hsl} / ${alpha})`;
}
```

Konva styles are computed at render time from this helper. When the user toggles theme, the `BlockLayer` listens to `MutationObserver` on `document.documentElement.class` and re-renders block fills.

## Microinteraction implementation notes

| Interaction | Tailwind class | Timing function |
|---|---|---|
| Drawer slide-up | `transition-transform duration-200 ease-out-quart` | `cubic-bezier(0.25, 1, 0.5, 1)` |
| Hover backgrounds | `transition-colors duration-100` | default ease-out |
| Selection transformer fade | Konva `Tween`, 120ms, easing `Konva.Easings.EaseOut` | — |
| Article color cross-fade | Konva `Tween` on `fill`, 180ms | — |
| Progress dialog enter | `data-[state=open]:animate-in fade-in zoom-in-95 duration-200` | tailwindcss-animate |
| ⌘K palette enter | `data-[state=open]:animate-in fade-in zoom-in-95 duration-100` | tailwindcss-animate |
| Reduced motion | global `@media (prefers-reduced-motion: reduce)` rule | — |

## Type scale binding

`globals.css` declares utility classes `.text-xs/.text-sm/...` with custom rem values; **don't** mix in Tailwind's default `text-xs` (which is also 0.75rem) — they're already overridden by the layer above. Use them via Tailwind's `text-sm` etc. classnames, the values come from our `@layer utilities` block.

## Open implementation questions

Tracked as code TODOs to revisit in M5 / M6:
- `// TODO(canvas): cap pixelRatio={1} on Konva Stage to halve memory at 300 DPI on retina`
- `// TODO(drawer): persist drawer height per-file in pageStateSlice`
- `// TODO(palette): wire ⌘K to invoke every toolbar action + every queue file by name`
- `// TODO(settings): "Import legacy ~/.xcvt/config.json" button — read-only, no overwrite`
