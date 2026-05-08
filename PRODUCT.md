# PRODUCT — Xcvt

Tauri-based desktop OCR tool for marking and transcribing 民国 (Republican-era Chinese) newspaper page scans. Users frame article boundaries on a high-resolution canvas, group rectangles into named articles, route them through one of four cloud or local OCR providers, and export structured text documents. Originally a PySide6 single-file app; this rewrite preserves every behavior while modernizing the experience for long archival sessions.

**register: product**

## Users

The single user who matters: a humanities PhD candidate or junior faculty working with Chinese press archives — typical session is 90 minutes to several hours, in a dim study at night, with 20–80 newspaper page scans queued up. They've already done dissertation-level squinting at 字林西报 and 申报 broadsheets. They are technical enough to manage API keys and edit prompts, not technical enough to enjoy fighting tooling. Their tolerance for hidden state, surprising defaults, and "modern" SaaS chrome is low; their tolerance for keyboard density, monospace numerals, and dense panels is high.

Concrete personas that anchor every decision:
- **Kai** — historian writing a dissertation chapter on Reuters' news network in 1940s Shanghai. Imports a folder of 60 scanned 字林西报 pages, marks 8–15 articles per page, runs batch OCR overnight, returns in the morning to read through results.
- **Junior reporter** at a Chinese newsroom doing media-history research, exporting to .md for a Notion / Bear archive. Cares about clean exports more than UI flourishes.

## Product purpose

Given a queue of newspaper-page scans (PNG/JPG/TIFF/BMP or multi-page PDFs), let the user:
1. Frame article rectangles on the page (manual marking is the right answer — auto-segmentation on Republican-era layouts is unreliable).
2. Group rectangles into named articles, with stable selection-order tracking.
3. Run OCR per-article via a chosen provider (PaddleOCR, OpenAI, Claude, or OpenRouter), or full-page, or batch over the whole queue.
4. Get back a structured text document: 报刊名 + 日期 + 一篇篇标题与正文。

The app must keep a long-running batch job alive, recoverable across crashes, and visible enough that the user can step away to tea and return without anxiety.

## Tone

- **Archival, not corporate.** This tool sits next to scanned 1947 broadsheets and Chinese-language scholarly notes, not next to Slack and Jira.
- **Quiet competence.** No celebratory toasts, no animated emoji, no friendly empty-state mascots. Confirm with text and motion economy.
- **Bilingual, Chinese-leaning UI.** Labels in 简体中文 first, English secondary where useful (e.g. provider names). Numerals and identifiers in tabular monospace.

## Anti-references

What this app is **not**:
- **Not a SaaS dashboard.** No metric cards, no gradient hero numbers, no "Welcome back, Kai 👋."
- **Not a photo editor.** Tool palettes that surround the image with chrome from four sides are a Photoshop affordance and they bury the canvas.
- **Not Notion / Linear.** That breezy SaaS-cream + light-blue accent palette is exactly the category trap to avoid; this is heavier, warmer, more focused.
- **Not a vibe coder's "AI tool" with neon green on jet black.** That's the second-order trap — the right answer to "tool that's not SaaS-cream" is *not* "terminal-cyberpunk."

Mental reference points instead:
- A focused IDE in a quiet color (Sublime Text, Zed dark, Ghostty terminals) — *the work* dominates the screen.
- The marginalia of a 1940s Shanghai manuscript: ink-warm browns, paper-cream off-whites, a single saturated red stamp for emphasis.
- Linear's keyboard density and information rhythm, but in a much warmer, much less SaaS palette.

## Strategic principles

1. **The canvas is the product.** Every panel must justify its pixels against the image. Default state hides what the current step doesn't need.
2. **Batch is a first-class citizen.** Folder-recursive import, dual-progress, pause/resume, retry-failed-only — not a tab three menus deep.
3. **Keyboard parity.** Anything reachable by mouse should be reachable by keyboard, surfaced through a ⌘K command palette and a printed shortcut sheet.
4. **No mystery state.** Every long-running job has a visible progress + cancel; every error is human-readable; every result is recoverable from disk.
5. **Locality over network.** PDF rendering, image processing, secret storage, cache, and logs are all local. The network is only OCR API calls, and only when the user pulls the trigger.
6. **One way to do each thing.** Linear's discipline: don't add a second button that does almost-the-same.

## Out of scope (explicit)

- PWA or browser version
- Mobile or tablet UX
- Auto layout segmentation (manual marking is correct for this corpus)
- Real-time collaboration
- Cloud sync of project state
