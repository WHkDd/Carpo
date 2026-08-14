import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Download,
  Eye,
  FileDown,
  FileCode,
  LayoutList,
  Printer,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useStore } from "@/store";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { t as translate, useT } from "@/i18n";
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
type OcrViewMode = "preview" | "source" | "blocks";

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

function countRecognizedPageText(
  pages: Record<number, RecognizedPage> | undefined
): number {
  return Object.values(pages ?? {}).filter((entry) => entry.text.length > 0)
    .length;
}

function buildLayoutDocumentFromRecognizedPages(
  pages: Record<number, RecognizedPage> | undefined
): LayoutDocument | null {
  const layoutPages = Object.values(pages ?? {})
    .map((entry) => {
      if (!entry.layout) return null;
      if (!entry.textEdited || entry.text.trim().length === 0) {
        return entry.layout;
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

function useBulkOcrText() {
  const fileId = useStore((s) => s.currentFileId);
  const recognitionMode = useStore((s) => s.recognitionMode);
  const documentResults = useStore((s) => s.documentResults);
  const articleOcrTexts = useStore((s) => s.articleOcrTexts);
  const articles = useStore((s) => s.getDocumentState(fileId ?? "").articles);
  const pageOcrTexts = useStore((s) => s.pageOcrTexts);
  const recognizedPages = useStore((s) => s.recognizedPages);
  const files = useStore((s) => s.files);
  const docState = useStore((s) => s.getDocumentState(fileId ?? ""));

  const fileEntry = useMemo(
    () => files.find((f) => f.id === fileId) ?? null,
    [files, fileId]
  );

  const getBulkText = useCallback(() => {
    if (!fileId) return "";
    if (recognitionMode === "whole_file") {
      const pages = recognizedPages[fileId];
      return hasRecognizedPageText(pages)
        ? buildAllRecognizedPagesText(pages ?? {})
        : buildAllPagesText(pageOcrTexts[fileId] ?? {});
    }
    const assembled = documentResults[fileId] ?? "";
    if (assembled.length > 0) return assembled;

    const texts = articleOcrTexts[fileId] ?? {};
    const ordered = articles
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
  }, [
    fileId,
    recognitionMode,
    recognizedPages,
    pageOcrTexts,
    documentResults,
    articleOcrTexts,
    articles,
    docState.newspaperName,
    docState.newspaperDate,
  ]);

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

  // Count *units* (articles in grouped mode, pages in whole-file mode) that
  // contributed non-empty OCR text. This is intentionally evaluated only
  // after a bulk action succeeds, so the normal render path never sorts and
  // joins all page text for large documents.
  const getBulkCount = useCallback(() => {
    if (!fileId) return 0;
    if (recognitionMode === "whole_file") {
      const pages = recognizedPages[fileId];
      const recognizedCount = countRecognizedPageText(pages);
      if (recognizedCount > 0) return recognizedCount;
      const legacyPages = pageOcrTexts[fileId] ?? {};
      return Object.values(legacyPages).filter((t) => t && t.length > 0).length;
    }
    const texts = articleOcrTexts[fileId] ?? {};
    return articles.filter((a) => (texts[a.id] ?? "").length > 0).length;
  }, [
    fileId,
    recognitionMode,
    recognizedPages,
    pageOcrTexts,
    articleOcrTexts,
    articles,
  ]);

  const layoutDocument = useMemo(() => {
    if (!fileId || recognitionMode !== "whole_file") return null;
    return buildLayoutDocumentFromRecognizedPages(recognizedPages[fileId]);
  }, [fileId, recognitionMode, recognizedPages]);
  const getLayoutDocument = useCallback(() => layoutDocument, [layoutDocument]);

  return {
    fileId,
    getBulkText,
    getLayoutDocument,
    fileLabel: fileEntry?.name ?? translate("common.untitledFile"),
    hasFile: fileId !== null,
    recognitionMode,
    hasBulkText,
    hasLayoutDocument: layoutDocument !== null,
    getBulkCount,
  };
}

export function OcrBulkActions() {
  const t = useT();
  const {
    getBulkText,
    getLayoutDocument,
    fileLabel,
    hasFile,
    recognitionMode,
    hasBulkText,
    hasLayoutDocument,
    getBulkCount,
  } = useBulkOcrText();
  const [copied, setCopied] = useState(false);
  const [copiedCount, setCopiedCount] = useState(0);
  const [savedTip, setSavedTip] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exportingLayoutPdf, setExportingLayoutPdf] = useState(false);
  const canExportLayoutPdf = isTauriRuntime();

  const showSavedTip = useCallback((tip: string) => {
    setSavedTip(tip);
    setTimeout(() => setSavedTip(null), 2000);
  }, []);

  const onCopyAll = useCallback(async () => {
    const allText = getBulkText();
    if (!allText) return;
    setSaveError(null);
    try {
      await copyText(allText);
      setCopiedCount(getBulkCount());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setSaveError(t("ocr.copyFailed", { message: appErrorMessage(e) }));
    }
  }, [getBulkText, getBulkCount, t]);

  const onSaveAll = useCallback(async () => {
    const allText = getBulkText();
    if (!allText) return;
    setSaveError(null);
    try {
      const stem = fileLabel.replace(/\.[^.]+$/, "");
      const defaultName =
        recognitionMode === "whole_file"
          ? `${stem}_${t("file.suffix.allPages")}.md`
          : `${stem}_${t("file.suffix.allArticles")}.md`;
      const saved = await saveTextFile(allText, {
        defaultName,
        filters: SAVE_FILTERS,
      });
      if (!saved) return;
      showSavedTip(t("ocr.exported"));
    } catch (e) {
      setSaveError(t("ocr.saveFailed", { message: appErrorMessage(e) }));
    }
  }, [
    getBulkText,
    fileLabel,
    recognitionMode,
    showSavedTip,
    t,
  ]);

  const onExportLayoutPdf = useCallback(async () => {
    const document = getLayoutDocument();
    if (!document || !isTauriRuntime()) return;
    setSaveError(null);
    setExportingLayoutPdf(true);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const stem = fileLabel.replace(/\.[^.]+$/, "");
      const target = await save({
        defaultPath: `${stem}_${t("file.suffix.reading")}.pdf`,
        filters: PDF_FILTERS,
      });
      if (!target) return;
      await ipcExportLayoutPdf({
        document,
        targetPath: target,
        options: DEFAULT_LAYOUT_PDF_EXPORT_OPTIONS,
      });
      showSavedTip(t("ocr.exportedPdf"));
    } catch (e) {
      setSaveError(t("ocr.exportFailed", { message: appErrorMessage(e) }));
    } finally {
      setExportingLayoutPdf(false);
    }
  }, [
    getLayoutDocument,
    fileLabel,
    showSavedTip,
    t,
  ]);

  if (!hasFile) return null;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {copied && (
        <span
          className="flex items-center gap-1 text-[10px] text-foreground-muted"
          role="status"
        >
          <Check className="h-3 w-3" strokeWidth={1.9} aria-hidden />
          {recognitionMode === "whole_file"
            ? t("ocr.copiedPages", { count: copiedCount })
            : t("ocr.copiedArticles", { count: copiedCount })}
        </span>
      )}
      {savedTip && (
        <span
          className="flex items-center gap-1 text-[10px] text-foreground-muted"
          role="status"
        >
          <Check className="h-3 w-3" strokeWidth={1.9} aria-hidden />
          {savedTip}
        </span>
      )}
      {saveError && (
        <span
          className="max-w-48 truncate text-[10px] text-destructive"
          title={saveError}
        >
          {saveError}
        </span>
      )}
      <button
        type="button"
        disabled={!hasBulkText}
        onClick={() => void onCopyAll()}
        title={
          recognitionMode === "whole_file"
            ? t("ocr.copyAllPages")
            : t("ocr.copyAllArticles")
        }
        aria-label={
          recognitionMode === "whole_file"
            ? t("ocr.copyAllPages")
            : t("ocr.copyAllArticles")
        }
        className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
      >
        <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        disabled={!hasBulkText}
        onClick={() => void onSaveAll()}
        title={
          recognitionMode === "whole_file"
            ? t("ocr.exportAllPages")
            : t("ocr.exportAllArticles")
        }
        aria-label={
          recognitionMode === "whole_file"
            ? t("ocr.exportAllPages")
            : t("ocr.exportAllArticles")
        }
        className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
      >
        <FileDown className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
      {canExportLayoutPdf && (
        <button
          type="button"
          disabled={!hasLayoutDocument || exportingLayoutPdf}
          onClick={() => void onExportLayoutPdf()}
          title={t("ocr.exportLayoutPdf")}
          aria-label={t("ocr.exportLayoutPdf")}
          className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
        >
          <Printer className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
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

  const [draft, setDraft] = useState(text);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Count the draft, not the store text, so the figure tracks in-flight edits.
  const charCount = draft.length;
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<OcrViewMode>("preview");

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

  const pinnedArticleId = pinnedArticle?.article.id ?? null;
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

  const onCopy = useCallback(async () => {
    setSaveError(null);
    try {
      await copyText(draftRef.current);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setSaveError(t("ocr.copyFailed", { message: appErrorMessage(e) }));
    }
  }, [t]);

  const onSave = useCallback(async () => {
    setSaveError(null);
    try {
      const stem = fileLabel.replace(/\.[^.]+$/, "");
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
      const saved = await saveTextFile(draftRef.current, {
        defaultName,
        filters: SAVE_FILTERS,
      });
      if (!saved) return;
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setSaveError(t("ocr.saveFailed", { message: appErrorMessage(e) }));
    }
  }, [fileLabel, recognitionMode, pinnedArticle, hasMultiplePages, currentPage, t]);

  const titleLabel =
    recognitionMode === "whole_file"
      ? t("ocr.pageHeading", { page: currentPage })
      : pinnedArticle
        ? pinnedArticle.article.title ||
          t("article.defaultTitle", { num: pinnedArticle.article.num })
        : t("ocr.titleFullText");

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 px-2 pt-2 pb-1">
      <div className="flex items-center justify-between gap-2 px-1.5">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px]">
          {recognitionMode === "whole_file" && hasMultiplePages ? (
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
        </div>
        {hasContent && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5">
            {copied && (
              <span className="text-[10px] text-foreground-muted">
                {t("ocr.copied")}
              </span>
            )}
            {saved && (
              <span className="text-[10px] text-foreground-muted">
                {t("ocr.saved")}
              </span>
            )}
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
            <button
              type="button"
              onClick={() => void onCopy()}
              title={t("common.copy")}
              aria-label={t("common.copy")}
              disabled={!hasText}
              className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
            >
              <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={() => void onSave()}
              title={t("ocr.save")}
              aria-label={t("ocr.save")}
              disabled={!hasText}
              className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </div>
        )}
      </div>

      {saveError && (
        <p className="px-1.5 text-[10px] text-destructive" role="alert">
          {saveError}
        </p>
      )}

      {hasContent ? (
        viewMode === "blocks" && currentLayout && fileId ? (
          <LayoutBlockList
            key={`${fileId}:${currentPage}`}
            fileId={fileId}
            page={currentPage}
            layout={currentLayout}
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

      {(hasText || (viewMode === "blocks" && currentLayout)) && (
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
