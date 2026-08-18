import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Eye,
  FileCode,
  FileDown,
  LayoutList,
  ListChecks,
  Loader2,
  Sparkles,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useStore, type AppStore } from "@/store";
import { selectJobStartBlocked } from "@/store/jobSlice";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { t as translate, useT } from "@/i18n";
import { alertError } from "@/lib/confirm";
import { cn } from "@/lib/utils";
import { assembleDocument } from "@/lib/format-doc";
import { appErrorMessage } from "@/lib/ipc-types";
import { copyText, isTauriRuntime, saveTextFile } from "@/lib/runtime";
import {
  DEFAULT_LAYOUT_PDF_EXPORT_OPTIONS,
  type LayoutBlock,
  type LayoutDocument,
  type LayoutPage,
} from "@/lib/layout-document";
import { exportLayoutPdf as ipcExportLayoutPdf } from "@/lib/tauri";
import { PageJumpControl } from "@/components/layout/PageJumpControl";
import { LayoutBlockList } from "@/components/structure/LayoutBlockList";
import { ProofreadReviewPanel } from "@/components/structure/ProofreadReviewPanel";
import { DropMenu, type DropMenuEntry } from "@/components/ui/DropMenu";
import { useProofreadTrigger } from "@/hooks/useProofreadTrigger";
import type { RecognizedPage } from "@/store/jobSlice";

const SAVE_FILTERS = [
  { name: "Markdown", extensions: ["md"] },
  { name: "Text", extensions: ["txt"] },
];
const PDF_FILTERS = [{ name: "PDF", extensions: ["pdf"] }];

/** Threshold above which the OCR text panel falls back to a plain
 *  `<pre>` view instead of rendering through ReactMarkdown + KaTeX.
 *  Above ~100 KB, the markdown/math passes start to noticeably block the
 *  main thread on every re-render; the pre view is `O(1)` to update. */
const MARKDOWN_RENDER_LIMIT_CHARS = 100_000;
type OcrViewMode = "preview" | "source" | "blocks" | "review";
type ExportAction = "current" | "all" | "pdf";

/** Keys of the proofread split button's dropdown. Model selection lives in
 *  the settings dialog's proofread tab, not here — the menu only carries the
 *  grouped-mode batch scope. */
type ProofreadMenuKey = "scope-all";

function buildAllPagesText(pageTexts: Record<number, string>): string {
  return Object.entries(pageTexts)
    .map(([page, text]) => ({ page: Number(page), text }))
    .filter((entry) => Number.isFinite(entry.page) && entry.text.length > 0)
    .sort((a, b) => a.page - b.page)
    .map(
      (entry) =>
        `# ${translate("ocr.pageHeading", { page: entry.page })}\n\n${entry.text.trim()}`
    )
    .join("\n\n");
}

function buildAllRecognizedPagesText(
  pages: Record<number, RecognizedPage>
): string {
  return Object.entries(pages)
    .map(([page, result]) => ({ page: Number(page), text: result.text }))
    .filter((entry) => Number.isFinite(entry.page) && entry.text.length > 0)
    .sort((a, b) => a.page - b.page)
    .map(
      (entry) =>
        `# ${translate("ocr.pageHeading", { page: entry.page })}\n\n${entry.text.trim()}`
    )
    .join("\n\n");
}

function hasRecognizedPageText(
  pages: Record<number, RecognizedPage> | undefined
): boolean {
  return Object.values(pages ?? {}).some((entry) => entry.text.length > 0);
}

/** Pure mapping from recognized pages to the reading-edition document —
 *  exported for tests. 条 8: a page the user *edited to empty* must never
 *  fall back to its old OCR layout (the reading PDF would otherwise
 *  resurrect the deleted text). Only pages that were never touched keep the
 *  original layout; an emptied page becomes a page with no blocks, which the
 *  Rust reading-edition builder renders as a page-number anchor only. */
export function buildLayoutDocumentFromRecognizedPages(
  pages: Record<number, RecognizedPage> | undefined
): LayoutDocument | null {
  const layoutPages = Object.values(pages ?? {})
    .map((entry) => {
      if (!entry.layout) return null;
      if (!entry.textEdited) return entry.layout;
      if (entry.text.trim().length === 0) {
        return { ...entry.layout, blocks: [] };
      }
      const editedBlock: LayoutBlock = {
        label: "text",
        text: entry.text,
        bbox: [0, 0, entry.layout.width, entry.layout.height],
        order: 1,
      };
      return {
        ...entry.layout,
        blocks: [editedBlock],
      };
    })
    .filter((page): page is LayoutPage => !!page)
    .sort((a, b) => a.index - b.index);
  if (layoutPages.length === 0) return null;
  return { source: "paddle", pages: layoutPages };
}

/**
 * Assembles the bulk text from a store *snapshot* rather than from subscribed
 * values.
 *
 * This is what lets the panel call `flushWriteBack()` and then immediately ask
 * for the bulk text: the flush writes through `set()`, so a callback closed
 * over values from the current render would still hand back the pre-flush
 * text — the user's last 400 ms of typing would silently miss the export.
 */
function selectBulkText(state: AppStore, fileId: string): string {
  if (state.recognitionMode === "whole_file") {
    const pages = state.recognizedPages[fileId];
    return hasRecognizedPageText(pages)
      ? buildAllRecognizedPagesText(pages ?? {})
      : buildAllPagesText(state.pageOcrTexts[fileId] ?? {});
  }
  const assembled = state.documentResults[fileId] ?? "";
  if (assembled.length > 0) return assembled;

  const docState = state.getDocumentState(fileId);
  const texts = state.articleOcrTexts[fileId] ?? {};
  const ordered = docState.articles
    .map((article) => ({
      title: article.title,
      text: texts[article.id] ?? "",
    }))
    .filter((article) => article.text.length > 0);
  return assembleDocument({
    newspaperName: docState.newspaperName,
    newspaperDate: docState.newspaperDate,
    articles: ordered,
  });
}

function useBulkOcrText() {
  const fileId = useStore((s) => s.currentFileId);
  const recognitionMode = useStore((s) => s.recognitionMode);
  const documentResults = useStore((s) => s.documentResults);
  const articleOcrTexts = useStore((s) => s.articleOcrTexts);
  const articles = useStore((s) => s.getDocumentState(fileId ?? "").articles);
  const pageOcrTexts = useStore((s) => s.pageOcrTexts);
  const recognizedPages = useStore((s) => s.recognizedPages);
  const files = useStore((s) => s.files);

  const fileEntry = useMemo(
    () => files.find((f) => f.id === fileId) ?? null,
    [files, fileId]
  );

  const getBulkText = useCallback(() => {
    if (!fileId) return "";
    return selectBulkText(useStore.getState(), fileId);
  }, [fileId]);

  const hasBulkText = useMemo(() => {
    if (!fileId) return false;
    if (recognitionMode === "whole_file") {
      const pages = recognizedPages[fileId];
      if (hasRecognizedPageText(pages)) return true;
      const legacyPages = pageOcrTexts[fileId] ?? {};
      return Object.values(legacyPages).some((t) => t && t.length > 0);
    }
    if ((documentResults[fileId] ?? "").length > 0) return true;
    const texts = articleOcrTexts[fileId] ?? {};
    return articles.some((a) => (texts[a.id] ?? "").length > 0);
  }, [
    fileId,
    recognitionMode,
    recognizedPages,
    pageOcrTexts,
    documentResults,
    articleOcrTexts,
    articles,
  ]);

  // Whether a reading-view PDF is available at all. Only the boolean is
  // derived on the render path; the document itself is rebuilt on demand from
  // a fresh snapshot, for the same reason `getBulkText` is.
  const hasLayoutDocument = useMemo(() => {
    if (!fileId || recognitionMode !== "whole_file") return false;
    return Object.values(recognizedPages[fileId] ?? {}).some((p) => !!p.layout);
  }, [fileId, recognitionMode, recognizedPages]);

  const getLayoutDocument = useCallback(() => {
    if (!fileId) return null;
    const state = useStore.getState();
    if (state.recognitionMode !== "whole_file") return null;
    return buildLayoutDocumentFromRecognizedPages(state.recognizedPages[fileId]);
  }, [fileId]);

  return {
    fileId,
    getBulkText,
    getLayoutDocument,
    fileLabel: fileEntry?.name ?? translate("common.untitledFile"),
    hasFile: fileId !== null,
    recognitionMode,
    hasBulkText,
    hasLayoutDocument,
  };
}

export function OcrTextPanel() {
  const t = useT();
  const fileId = useStore((s) => s.currentFileId);
  const recognitionMode = useStore((s) => s.recognitionMode);
  const documentResults = useStore((s) => s.documentResults);
  const articleOcrTexts = useStore((s) => s.articleOcrTexts);
  const selectedArticleIds = useStore((s) => s.selectedArticleIds);
  const articles = useStore(
    (s) => s.getDocumentState(fileId ?? "").articles
  );
  const pageOcrTexts = useStore((s) => s.pageOcrTexts);
  const recognizedPages = useStore((s) => s.recognizedPages);
  const files = useStore((s) => s.files);
  const updateRecognizedPageText = useStore((s) => s.updateRecognizedPageText);
  const updateArticleOcrText = useStore((s) => s.updateArticleOcrText);
  const setDocumentResult = useStore((s) => s.setDocumentResult);
  // Same gate the two OCR entry points use (StructureRail). The proofread
  // button used to check only its own hook's `starting`, so an OCR run — or
  // another proofread whose start RPC was still in flight — did not stop it.
  const jobStartBlocked = useStore(selectJobStartBlocked);

  const proofread = useProofreadTrigger();

  const fileEntry = useMemo(
    () => files.find((f) => f.id === fileId) ?? null,
    [files, fileId]
  );
  const fileLabel = fileEntry?.name ?? t("common.untitledFile");
  const totalPages = fileEntry?.pdfTotal ?? 1;
  const currentPage = fileEntry?.currentPage ?? 1;
  const hasMultiplePages = totalPages > 1;

  const pinnedArticle = useMemo(() => {
    if (!fileId || selectedArticleIds.length !== 1) return null;
    const id = selectedArticleIds[0]!;
    const article = articles.find((a) => a.id === id) ?? null;
    if (!article) return null;
    const text = articleOcrTexts[fileId]?.[id] ?? "";
    return { article, text };
  }, [fileId, selectedArticleIds, articles, articleOcrTexts]);

  const pinnedArticleId = pinnedArticle?.article.id ?? null;

  const articleText = pinnedArticle
    ? pinnedArticle.text
    : fileId
      ? documentResults[fileId] ?? ""
      : "";
  const pageText = fileId
    ? recognizedPages[fileId]?.[currentPage]?.text ??
      pageOcrTexts[fileId]?.[currentPage] ??
      ""
    : "";
  const currentLayout =
    recognitionMode === "whole_file" && fileId
      ? recognizedPages[fileId]?.[currentPage]?.layout
      : undefined;
  const hasLayout = !!currentLayout;

  const text = recognitionMode === "whole_file" ? pageText : articleText;
  const hasText = text.length > 0;
  const hasContent = hasText || hasLayout;

  const {
    getBulkText,
    getLayoutDocument,
    hasBulkText,
    hasLayoutDocument,
  } = useBulkOcrText();
  const canExportLayoutPdf = isTauriRuntime();

  const [draft, setDraft] = useState(text);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Count the draft, not the store text, so the figure tracks in-flight edits.
  const charCount = draft.length;
  const [copied, setCopied] = useState(false);
  const [exportingLayoutPdf, setExportingLayoutPdf] = useState(false);
  // Only ever set in the browser build, where there is no native error dialog
  // to put a failed write in front of the user (see `alertError`).
  const [saveError, setSaveError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<OcrViewMode>("preview");

  // --- Proofread review wiring --------------------------------------------
  const proofreadKey = fileId
    ? recognitionMode === "whole_file"
      ? `page:${currentPage}`
      : pinnedArticleId
        ? `article:${pinnedArticleId}`
        : null
    : null;
  const proofreadReview = useStore(
    (s) =>
      (fileId && proofreadKey
        ? s.proofreadReviews[fileId]?.[proofreadKey]
        : null) ?? null
  );

  // A review is a content source of its own, not a decoration on the text.
  // Emptying a page (or an article) must not strand its undecided review: the
  // queue badge keeps counting it, so there has to be a way in to discard or
  // re-run it. Only the preview / source buttons stay tied to `hasText`.
  const hasReview = proofreadReview !== null;

  // A freshly finished run drops the user straight into the review view —
  // the review appearing *is* the completion feedback (C3: no toast). The
  // same identity guard also covers arriving at a page that already has an
  // undecided review; Escape leaves, and the id keeps us from re-opening it.
  const lastAutoOpenedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!proofreadReview || proofreadReview.status !== "pending") return;
    const id = `${fileId}:${proofreadKey}:${proofreadReview.createdAt}`;
    if (lastAutoOpenedRef.current === id) return;
    lastAutoOpenedRef.current = id;
    setViewMode("review");
  }, [proofreadReview, fileId, proofreadKey]);

  // The review view is only ever open *for* the current target's review;
  // navigating away (or discarding it) falls back to the preview instead of
  // leaving an empty view behind.
  useEffect(() => {
    if (viewMode === "review" && !proofreadReview) setViewMode("preview");
  }, [viewMode, proofreadReview]);

  const proofreadItems = useMemo(() => {
    const entries: DropMenuEntry<ProofreadMenuKey>[] = [];
    if (recognitionMode === "grouped") {
      // Scope section: the extra articles in grouped mode. One entry, an
      // action — not a radio, nothing is "selected" by running it. Which
      // model runs is the settings dialog's business (proofread tab), not
      // this menu's.
      entries.push({
        key: "scope-all",
        label: t("proofread.allArticles", {
          count: proofread.state.allArticleTargetCount,
        }),
        variant: "action",
        disabled:
          proofread.state.allArticleTargetCount === 0 ||
          proofread.state.starting ||
          jobStartBlocked,
      });
    }
    return entries;
  }, [
    recognitionMode,
    proofread.state.allArticleTargetCount,
    proofread.state.starting,
    jobStartBlocked,
    t,
  ]);

  const proofreadLabel =
    recognitionMode === "whole_file"
      ? t("proofread.currentPage")
      : t("proofread.selectedArticle");
  const canProofreadCurrent =
    proofread.state.hasCurrentTarget && !jobStartBlocked;

  // Debounced write-back of user edits into the store, so edits survive page
  // switches and flow into the bulk copy / export paths. The pending commit
  // closure captures its target (file / page / article) at keystroke time;
  // flushing before a position reset (or on unmount) guarantees a pending
  // edit lands on the position it was typed on, never the new one.
  const writeBackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWriteRef = useRef<(() => void) | null>(null);

  const flushWriteBack = useCallback(() => {
    if (writeBackTimerRef.current !== null) {
      clearTimeout(writeBackTimerRef.current);
      writeBackTimerRef.current = null;
    }
    const commit = pendingWriteRef.current;
    pendingWriteRef.current = null;
    commit?.();
  }, []);

  // Every proofread entry flushes the edit debounce first, then lets the
  // trigger derive its targets from the live store: the last 400 ms of
  // typing must be part of the request (E2 / 条 6).
  const runProofread = useCallback(() => {
    flushWriteBack();
    void proofread.triggerCurrent();
  }, [flushWriteBack, proofread]);

  const onProofreadSelect = useCallback(
    (key: ProofreadMenuKey) => {
      if (key === "scope-all") {
        flushWriteBack();
        void proofread.triggerAllArticles();
      }
    },
    [proofread, flushWriteBack]
  );

  const scheduleWriteBack = useCallback(
    (value: string) => {
      if (!fileId) return;
      const commit =
        recognitionMode === "whole_file"
          ? () => updateRecognizedPageText(fileId, currentPage, value)
          : pinnedArticleId
            ? () => updateArticleOcrText(fileId, pinnedArticleId, value)
            : () => setDocumentResult(fileId, value);
      if (writeBackTimerRef.current !== null) {
        clearTimeout(writeBackTimerRef.current);
      }
      pendingWriteRef.current = commit;
      writeBackTimerRef.current = setTimeout(() => {
        writeBackTimerRef.current = null;
        pendingWriteRef.current = null;
        commit();
      }, 400);
    },
    [
      fileId,
      recognitionMode,
      currentPage,
      pinnedArticleId,
      updateRecognizedPageText,
      updateArticleOcrText,
      setDocumentResult,
    ]
  );

  // Commit any pending edit if the panel unmounts mid-debounce.
  useEffect(() => () => flushWriteBack(), [flushWriteBack]);

  // Reset draft whenever the *logical* position changes (file / mode / pinned
  // article / page), committing the previous position's pending edit first.
  useEffect(() => {
    flushWriteBack();
    setDraft(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, recognitionMode, pinnedArticleId, currentPage]);

  // Store write-back (our own debounced commit, or a fresh OCR run): follow
  // the store unless an uncommitted edit is pending. After a commit the store
  // equals the draft, so this is a no-op; after a re-OCR it refreshes the view.
  useEffect(() => {
    if (!pendingWriteRef.current) {
      setDraft(text);
    }
  }, [text]);

  useEffect(() => {
    if (viewMode === "blocks" && !hasLayout) {
      setViewMode("preview");
    }
  }, [hasLayout, viewMode]);

  // Which document this panel is currently showing. The preview and the
  // source editor keep their own offsets: switching between them is a change
  // of representation, and the same line is nowhere near the same pixel.
  const scrollKey = `${fileId ?? ""}:${recognitionMode}:${
    pinnedArticleId ?? ""
  }:${currentPage}:${viewMode}`;
  const preview = useScrollMemory<HTMLDivElement>(scrollKey);
  const source = useScrollMemory<HTMLTextAreaElement>(scrollKey);

  // Failures go to the platform's error dialog; only the browser build, which
  // has none, falls back to the inline line of red text.
  const reportFailure = useCallback(
    async (title: string, inline: (message: string) => string, e: unknown) => {
      const detail = appErrorMessage(e);
      const shown = await alertError({ title, message: detail });
      if (!shown) setSaveError(inline(detail));
    },
    []
  );

  // Success feedback for copy is the icon itself flipping to a check for a
  // second — same size, so nothing in the toolbar moves. A ⌘C on macOS gives
  // no feedback at all, but this is a mouse click on a 24px icon and lacks the
  // keyboard's "I know I pressed it" certainty. The screen-reader path is the
  // live region in the toolbar, not the icon.
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    },
    []
  );

  const onCopy = useCallback(async () => {
    setSaveError(null);
    try {
      await copyText(draftRef.current);
      setCopied(true);
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = null;
        setCopied(false);
      }, 1000);
    } catch (e) {
      await reportFailure(
        t("ocr.copyFailedTitle"),
        (message) => t("ocr.copyFailed", { message }),
        e
      );
    }
  }, [reportFailure, t]);

  const stem = fileLabel.replace(/\.[^.]+$/, "");

  // Reads `draftRef`, not the store: the panel's own edits are 400 ms behind
  // the store, and exporting must never lose the last keystroke. This is why
  // export lives in the panel rather than in the rail header (see §1.2).
  const onExportCurrent = useCallback(async () => {
    setSaveError(null);
    try {
      const defaultName =
        recognitionMode === "whole_file"
          ? hasMultiplePages
            ? `${stem}_${t("file.suffix.page", { page: currentPage })}.md`
            : `${stem}.md`
          : pinnedArticle
            ? `${stem}_${
                pinnedArticle.article.title ||
                t("article.defaultTitle", { num: pinnedArticle.article.num })
              }.md`
            : `${stem}.md`;
      // The native save panel closing *is* the confirmation. A follow-up
      // "Exported" tip would be pure web redundancy (C3).
      await saveTextFile(draftRef.current, {
        defaultName,
        filters: SAVE_FILTERS,
      });
    } catch (e) {
      await reportFailure(
        t("ocr.exportFailedTitle"),
        (message) => t("ocr.saveFailed", { message }),
        e
      );
    }
  }, [
    stem,
    recognitionMode,
    pinnedArticle,
    hasMultiplePages,
    currentPage,
    reportFailure,
    t,
  ]);

  const onExportAll = useCallback(async () => {
    setSaveError(null);
    // Land the pending draft in the store first, then read it back — the whole
    // point of crossing this boundary explicitly.
    flushWriteBack();
    const allText = getBulkText();
    if (!allText) return;
    try {
      const defaultName =
        recognitionMode === "whole_file"
          ? `${stem}_${t("file.suffix.allPages")}.md`
          : `${stem}_${t("file.suffix.allArticles")}.md`;
      await saveTextFile(allText, { defaultName, filters: SAVE_FILTERS });
    } catch (e) {
      await reportFailure(
        t("ocr.exportFailedTitle"),
        (message) => t("ocr.saveFailed", { message }),
        e
      );
    }
  }, [flushWriteBack, getBulkText, stem, recognitionMode, reportFailure, t]);

  const onExportLayoutPdf = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setSaveError(null);
    flushWriteBack();
    const layoutDocument = getLayoutDocument();
    if (!layoutDocument) return;
    setExportingLayoutPdf(true);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = await save({
        defaultPath: `${stem}_${t("file.suffix.reading")}.pdf`,
        filters: PDF_FILTERS,
      });
      if (!target) return;
      await ipcExportLayoutPdf({
        document: layoutDocument,
        targetPath: target,
        options: DEFAULT_LAYOUT_PDF_EXPORT_OPTIONS,
      });
    } catch (e) {
      await reportFailure(
        t("ocr.exportFailedTitle"),
        (message) => t("ocr.exportFailed", { message }),
        e
      );
    } finally {
      setExportingLayoutPdf(false);
    }
  }, [flushWriteBack, getLayoutDocument, stem, reportFailure, t]);

  const canCopy =
    recognitionMode === "whole_file"
      ? hasText
      : hasText && pinnedArticleId !== null;
  const copyLabel =
    recognitionMode === "whole_file"
      ? t("ocr.copyCurrentPage")
      : t("ocr.copySelectedArticle");

  // Item 3 is absent rather than dimmed outside whole-file mode and off the
  // desktop: a native menu does not keep an entry that can never be used in
  // the current mode, but it does keep one that is merely unavailable now.
  const showLayoutPdfItem =
    canExportLayoutPdf && recognitionMode === "whole_file";

  const exportItems: DropMenuEntry<ExportAction>[] = [
    {
      key: "current",
      label:
        recognitionMode === "whole_file"
          ? t("ocr.exportCurrentPage")
          : t("ocr.exportSelectedArticle"),
      variant: "action",
      // Grouped mode has no "this one" without a pinned article; the entry
      // stays dimmed instead of quietly degrading into a full-text export,
      // which would make its label a lie. Full text is item 2.
      disabled: !canCopy,
    },
    {
      key: "all",
      label:
        recognitionMode === "whole_file"
          ? t("ocr.exportAllPages")
          : t("ocr.exportAllArticles"),
      variant: "action",
      disabled: !hasBulkText,
    },
    ...(showLayoutPdfItem
      ? [
          {
            key: "pdf" as const,
            label: exportingLayoutPdf
              ? t("ocr.exportingLayoutPdf")
              : t("ocr.exportLayoutPdf"),
            variant: "action" as const,
            disabled: !hasLayoutDocument || exportingLayoutPdf,
          },
        ]
      : []),
  ];

  const onExportSelect = useCallback(
    (key: ExportAction) => {
      if (key === "current") void onExportCurrent();
      else if (key === "all") void onExportAll();
      else void onExportLayoutPdf();
    },
    [onExportCurrent, onExportAll, onExportLayoutPdf]
  );

  const titleLabel =
    recognitionMode === "whole_file"
      ? t("ocr.pageHeading", { page: currentPage })
      : pinnedArticle
        ? pinnedArticle.article.title ||
          t("article.defaultTitle", { num: pinnedArticle.article.num })
        : t("ocr.titleFullText");

  const showPager = recognitionMode === "whole_file" && hasMultiplePages;

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 px-2 pt-2 pb-1">
      <div className="flex items-center justify-between gap-2 px-1.5">
        {/* The pager must stay whole at the rail's minimum width — a clipped
            "page 1 of ?" is worse than wrapped toolbar icons, so in pager
            mode this side refuses to shrink. RAIL_MIN_WIDTH is sized so the
            icons still fit beside it on one row; the `flex-wrap` below is
            only the fallback for a page count wider than that budget. A
            title has no such claim: it truncates as before. */}
        <div
          className={cn(
            "flex items-center gap-1.5 text-[11px]",
            showPager ? "shrink-0" : "min-w-0 overflow-hidden"
          )}
        >
          {showPager ? (
            <PageJumpControl
              fileId={fileId}
              currentPage={currentPage}
              totalPages={totalPages}
              variant="panel"
            />
          ) : (
            <span className="truncate font-medium text-foreground-muted">
              {titleLabel}
            </span>
          )}
          {/* The page-control marker from §3.7(c): this page has an
              undecided review. A dot, not text — the queue panel carries
              the countable badge, and the header has no room for one. */}
          {proofreadReview?.status === "pending" && (
            <span
              role="status"
              aria-label={t("proofread.pendingBadge", { count: 1 })}
              title={t("proofread.pendingBadge", { count: 1 })}
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            />
          )}
        </div>
        {/* Bulk export stays available on a page with no text of its own, so
            the toolbar's presence no longer flickers with the content. A native
            toolbar dims its items; it does not vanish. */}
        {(hasContent || hasBulkText || hasReview) && (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-0.5">
            {/* The toolbar's transient states are shown by the controls
                themselves (a check, a spinner); this is their screen-reader
                equivalent. Visually hidden, so it costs no layout and is not a
                toast. */}
            <span role="status" className="sr-only">
              {exportingLayoutPdf
                ? t("ocr.exportingLayoutPdf")
                : copied
                  ? t("ocr.copied")
                  : ""}
            </span>
            <button
              type="button"
              onClick={() => setViewMode("preview")}
              title={t("ocr.preview")}
              aria-label={t("ocr.switchToPreview")}
              disabled={!hasText}
              className={`grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40 ${
                viewMode === "preview" ? "bg-surface-2 text-foreground" : ""
              }`}
            >
              <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={() => setViewMode("source")}
              title={t("ocr.sourceView")}
              aria-label={t("ocr.switchToSource")}
              disabled={!hasText}
              className={`grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40 ${
                viewMode === "source" ? "bg-surface-2 text-foreground" : ""
              }`}
            >
              <FileCode className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
            {hasLayout && (
              <button
                type="button"
                onClick={() => setViewMode("blocks")}
                title={t("ocr.blockProofread")}
                aria-label={t("ocr.blockProofread")}
                className={`grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground ${
                  viewMode === "blocks" ? "bg-surface-2 text-foreground" : ""
                }`}
              >
                <LayoutList className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            )}
            {proofreadReview && (
              <button
                type="button"
                onClick={() => setViewMode("review")}
                title={t("proofread.reviewTitle")}
                aria-label={t("proofread.reviewTitle")}
                className={`grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground ${
                  viewMode === "review" ? "bg-surface-2 text-foreground" : ""
                }`}
              >
                <ListChecks className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            )}
            {/* Copy and export act on one thing; the view switches above pick
                how to look at it. A divider keeps the two groups apart the way
                a native toolbar would. */}
            <span className="mx-0.5 h-3.5 w-px bg-border" aria-hidden />
            <button
              type="button"
              onClick={() => void onCopy()}
              title={copyLabel}
              aria-label={copyLabel}
              disabled={!canCopy}
              className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" strokeWidth={1.75} />
              ) : (
                <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
            </button>
            <DropMenu<ExportAction>
              ariaLabel={t("ocr.exportMenu")}
              triggerIcon={
                // The reading-view PDF is rendered by Rust and can outlast the
                // save panel closing, which is the only other signal that
                // anything happened. Selecting a menu item closes the menu, so
                // the busy state has to live on the trigger to be visible at
                // all. Same 14px box as the idle icon, so nothing shifts.
                exportingLayoutPdf ? (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                    strokeWidth={1.75}
                  />
                ) : (
                  <FileDown className="h-3.5 w-3.5" strokeWidth={1.75} />
                )
              }
              triggerClassName="text-foreground-muted hover:text-foreground"
              placement="bottom"
              align="end"
              items={exportItems}
              onSelect={onExportSelect}
            />
            {/* The proofread button runs the current scope with one click; in
                grouped mode a dropdown adds the all-articles batch scope.
                Which model runs is configured in settings (proofread tab). A
                divider keeps this apart from the copy/export group — it is
                the only toolbar action that calls an external API, spends
                money, and cannot be undone by ⌘Z. */}
            <span className="mx-0.5 h-3.5 w-px bg-border" aria-hidden />
            <button
              type="button"
              onClick={runProofread}
              title={proofreadLabel}
              aria-label={proofreadLabel}
              disabled={!canProofreadCurrent || proofread.state.starting}
              className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
            >
              {proofread.state.starting ? (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                  strokeWidth={1.75}
                />
              ) : (
                <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
            </button>
            {proofreadItems.length > 0 && (
              <DropMenu<ProofreadMenuKey>
                ariaLabel={t("proofread.menu")}
                triggerClassName="text-foreground-muted hover:text-foreground"
                placement="bottom"
                align="end"
                items={proofreadItems}
                onSelect={onProofreadSelect}
              />
            )}
          </div>
        )}
      </div>

      {saveError && (
        <p className="px-1.5 text-[10px] text-destructive" role="alert">
          {saveError}
        </p>
      )}

      {proofread.state.error && (
        <p className="px-1.5 text-[10px] text-destructive" role="alert">
          {proofread.state.error}
        </p>
      )}

      {hasContent || hasReview ? (
        viewMode === "blocks" && currentLayout && fileId ? (
          <LayoutBlockList
            key={`${fileId}:${currentPage}`}
            fileId={fileId}
            page={currentPage}
            layout={currentLayout}
          />
        ) : viewMode === "review" && fileId && proofreadKey && proofreadReview ? (
          <ProofreadReviewPanel
            // Identity of the review, not of the target: a re-run replaces the
            // suggestions wholesale, so the panel's local selection/edit
            // indices must not survive it (an index of 90 against a new
            // 2-row review selects nothing at all).
            key={`${proofreadKey}:${proofreadReview.createdAt}`}
            fileId={fileId}
            targetKey={proofreadKey}
            review={proofreadReview}
            onClose={() => setViewMode("preview")}
            onReProofread={runProofread}
          />
        ) : viewMode === "source" && hasText ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {hasLayout && (
              <p className="mb-1 px-1.5 text-[10px] text-foreground-muted">
                {t("ocr.sourceLayoutNote")}
              </p>
            )}
            <textarea
              ref={source.ref}
              onScroll={source.onScroll}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                scheduleWriteBack(e.target.value);
              }}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none overscroll-contain rounded-md border border-border/40 bg-background px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-foreground outline-none focus:border-border-strong"
            />
          </div>
        ) : (
          <div
            ref={preview.ref}
            onScroll={preview.onScroll}
            className="prose-ocr min-h-0 flex-1 overflow-auto overscroll-contain rounded-md border border-border/40 bg-background px-3 py-2"
            data-native-context-menu
          >
            {draft.length > MARKDOWN_RENDER_LIMIT_CHARS ? (
              <>
                <div
                  className="mb-2 rounded border border-border/40 bg-surface-2 px-2 py-1 text-[10.5px] text-foreground-muted"
                  role="status"
                >
                  {t("ocr.plainTextNote", {
                    kb: Math.round(draft.length / 1024),
                  })}
                </div>
                <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-foreground">
                  {draft}
                </pre>
              </>
            ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                // KaTeX in non-trust / strict mode: refuses to expand
                // `\href`, `\url`, `\includegraphics`, etc. The OCR text
                // comes from third-party LLM providers, so no rehype-raw
                // and an explicit allow-list of safe elements.
                rehypePlugins={[[rehypeKatex, { strict: true, trust: false }]]}
                disallowedElements={["script", "iframe", "object", "embed", "form", "input", "button"]}
                unwrapDisallowed
              >
                {draft}
              </ReactMarkdown>
            )}
          </div>
        )
      ) : (
        <div
          className="min-h-0 flex-1 rounded-md border border-dashed border-border/50 bg-background/35"
          aria-hidden
        />
      )}

      {viewMode !== "review" &&
        (hasText || (viewMode === "blocks" && currentLayout)) && (
          <div className="flex shrink-0 items-center px-1.5">
            <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-foreground-subtle tabular-nums">
              {viewMode === "blocks" && currentLayout
                ? t("ocr.blockCount", {
                    count: currentLayout.blocks.length.toLocaleString(),
                  })
                : t("ocr.charCount", { count: charCount.toLocaleString() })}
            </span>
          </div>
        )}
    </div>
  );
}
