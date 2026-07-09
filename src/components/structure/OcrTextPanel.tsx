import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
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
import { assembleDocument } from "@/lib/format-doc";
import { appErrorMessage } from "@/lib/ipc-types";
import {
  DEFAULT_LAYOUT_PDF_EXPORT_OPTIONS,
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
    .map((entry) => `# 第 ${entry.page} 页\n\n${entry.text.trim()}`)
    .join("\n\n");
}

function buildAllRecognizedPagesText(
  pages: Record<number, RecognizedPage>
): string {
  return Object.entries(pages)
    .map(([page, result]) => ({ page: Number(page), text: result.text }))
    .filter((entry) => Number.isFinite(entry.page) && entry.text.length > 0)
    .sort((a, b) => a.page - b.page)
    .map((entry) => `# 第 ${entry.page} 页\n\n${entry.text.trim()}`)
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
    .map((entry) => entry.layout)
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
    getBulkText,
    getLayoutDocument,
    fileLabel: fileEntry?.name ?? "(未命名)",
    hasFile: fileId !== null,
    recognitionMode,
    hasBulkText,
    hasLayoutDocument: layoutDocument !== null,
    getBulkCount,
  };
}

export function OcrBulkActions() {
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
  const unitLabel = recognitionMode === "whole_file" ? "页" : "篇";

  const showSavedTip = useCallback((tip: string) => {
    setSavedTip(tip);
    setTimeout(() => setSavedTip(null), 2000);
  }, []);

  const onCopyAll = useCallback(async () => {
    const allText = getBulkText();
    if (!allText) return;
    setSaveError(null);
    try {
      await writeText(allText);
      setCopiedCount(getBulkCount());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setSaveError(`复制失败：${appErrorMessage(e)}`);
    }
  }, [getBulkText, getBulkCount]);

  const onSaveAll = useCallback(async () => {
    const allText = getBulkText();
    if (!allText) return;
    setSaveError(null);
    try {
      const stem = fileLabel.replace(/\.[^.]+$/, "");
      const defaultName =
        recognitionMode === "whole_file"
          ? `${stem}_全文按页.md`
          : `${stem}_全部报道.md`;
      const target = await save({
        defaultPath: defaultName,
        filters: SAVE_FILTERS,
      });
      if (!target) return;
      await writeTextFile(target, allText);
      showSavedTip("已导出");
    } catch (e) {
      setSaveError(`保存失败：${appErrorMessage(e)}`);
    }
  }, [getBulkText, fileLabel, recognitionMode, showSavedTip]);

  const onExportLayoutPdf = useCallback(async () => {
    const document = getLayoutDocument();
    if (!document) return;
    setSaveError(null);
    setExportingLayoutPdf(true);
    try {
      const stem = fileLabel.replace(/\.[^.]+$/, "");
      const target = await save({
        defaultPath: `${stem}_版式重建.pdf`,
        filters: PDF_FILTERS,
      });
      if (!target) return;
      await ipcExportLayoutPdf({
        document,
        targetPath: target,
        options: DEFAULT_LAYOUT_PDF_EXPORT_OPTIONS,
      });
      showSavedTip("已导出 PDF");
    } catch (e) {
      setSaveError(`导出失败：${appErrorMessage(e)}`);
    } finally {
      setExportingLayoutPdf(false);
    }
  }, [getLayoutDocument, fileLabel, showSavedTip]);

  if (!hasFile) return null;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {copied && (
        <span
          className="flex items-center gap-1 text-[10px] text-foreground-muted"
          role="status"
        >
          <Check className="h-3 w-3" strokeWidth={1.9} aria-hidden />
          已复制 {copiedCount} {unitLabel}
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
        title={recognitionMode === "whole_file" ? "复制所有页" : "复制所有报道"}
        aria-label={
          recognitionMode === "whole_file" ? "复制所有页" : "复制所有报道"
        }
        className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
      >
        <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        disabled={!hasBulkText}
        onClick={() => void onSaveAll()}
        title={recognitionMode === "whole_file" ? "导出所有页" : "导出所有报道"}
        aria-label={
          recognitionMode === "whole_file" ? "导出所有页" : "导出所有报道"
        }
        className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
      >
        <FileDown className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        disabled={!hasLayoutDocument || exportingLayoutPdf}
        onClick={() => void onExportLayoutPdf()}
        title="导出版式 PDF"
        aria-label="导出版式 PDF"
        className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
      >
        <Printer className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
}

export function OcrTextPanel() {
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
  const fileLabel = fileEntry?.name ?? "(未命名)";
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

  const onCopy = useCallback(async () => {
    setSaveError(null);
    try {
      await writeText(draftRef.current);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setSaveError(`复制失败：${appErrorMessage(e)}`);
    }
  }, []);

  const onSave = useCallback(async () => {
    setSaveError(null);
    try {
      const stem = fileLabel.replace(/\.[^.]+$/, "");
      const defaultName =
        recognitionMode === "whole_file"
          ? hasMultiplePages
            ? `${stem}_第${currentPage}页.md`
            : `${stem}.md`
          : pinnedArticle
            ? `${stem}_${pinnedArticle.article.title || `报道${pinnedArticle.article.num}`}.md`
            : `${stem}.md`;
      const target = await save({
        defaultPath: defaultName,
        filters: SAVE_FILTERS,
      });
      if (!target) return;
      await writeTextFile(target, draftRef.current);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setSaveError(`保存失败：${appErrorMessage(e)}`);
    }
  }, [fileLabel, recognitionMode, pinnedArticle, hasMultiplePages, currentPage]);

  const titleLabel =
    recognitionMode === "whole_file"
      ? `第 ${currentPage} 页`
      : pinnedArticle
        ? pinnedArticle.article.title || `报道${pinnedArticle.article.num}`
        : "全文";

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 px-2 pt-2 pb-1">
      <div className="flex items-center justify-between gap-2 px-1.5">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
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
          {(hasText || (viewMode === "blocks" && currentLayout)) && (
            <span className="font-mono text-foreground-subtle tabular-nums">
              {viewMode === "blocks" && currentLayout
                ? `${currentLayout.blocks.length.toLocaleString()} 块`
                : charCount.toLocaleString()}
            </span>
          )}
        </div>
        {hasContent && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5">
            {copied && (
              <span className="text-[10px] text-foreground-muted">已复制 ✓</span>
            )}
            {saved && (
              <span className="text-[10px] text-foreground-muted">已保存 ✓</span>
            )}
            <button
              type="button"
              onClick={() => setViewMode("preview")}
              title="预览"
              aria-label="切换到预览"
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
              title="编辑源码"
              aria-label="切换到源码"
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
                title="版面块校对"
                aria-label="版面块校对"
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
              title="复制"
              aria-label="复制"
              disabled={!hasText}
              className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
            >
              <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={() => void onSave()}
              title="保存"
              aria-label="保存"
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
                此处修改不影响版式 PDF，请在"版面块校对"视图逐块修改
              </p>
            )}
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                scheduleWriteBack(e.target.value);
              }}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none rounded-md border border-border/40 bg-background px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-foreground outline-none focus:border-border-strong"
            />
          </div>
        ) : (
          <div className="prose-ocr min-h-0 flex-1 overflow-auto rounded-md border border-border/40 bg-background px-3 py-2">
            {draft.length > MARKDOWN_RENDER_LIMIT_CHARS ? (
              <>
                <div
                  className="mb-2 rounded border border-border/40 bg-surface-2 px-2 py-1 text-[10.5px] text-foreground-muted"
                  role="status"
                >
                  文本约 {Math.round(draft.length / 1024)} KB，已切换到纯文本视图避免渲染卡顿
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
    </div>
  );
}
