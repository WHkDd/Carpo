import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  FileDown,
  FileCode,
  Files,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useStore } from "@/store";
import { assembleDocument } from "@/lib/format-doc";
import { cn } from "@/lib/utils";

function buildAllPagesText(pageTexts: Record<number, string>): string {
  return Object.entries(pageTexts)
    .map(([page, text]) => ({ page: Number(page), text }))
    .filter((entry) => Number.isFinite(entry.page) && entry.text.length > 0)
    .sort((a, b) => a.page - b.page)
    .map((entry) => `# 第 ${entry.page} 页\n\n${entry.text.trim()}`)
    .join("\n\n");
}

function useBulkOcrText() {
  const fileId = useStore((s) => s.currentFileId);
  const recognitionMode = useStore((s) => s.recognitionMode);
  const documentResults = useStore((s) => s.documentResults);
  const articleOcrTexts = useStore((s) => s.articleOcrTexts);
  const articles = useStore((s) => s.getDocumentState(fileId ?? "").articles);
  const pageOcrTexts = useStore((s) => s.pageOcrTexts);
  const files = useStore((s) => s.files);
  const docState = useStore((s) => s.getDocumentState(fileId ?? ""));

  const fileEntry = useMemo(
    () => files.find((f) => f.id === fileId) ?? null,
    [files, fileId]
  );

  const allText = useMemo(() => {
    if (!fileId) return "";
    if (recognitionMode === "whole_file") {
      return buildAllPagesText(pageOcrTexts[fileId] ?? {});
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
    pageOcrTexts,
    documentResults,
    articleOcrTexts,
    articles,
    docState.newspaperName,
    docState.newspaperDate,
  ]);

  return {
    allText,
    fileLabel: fileEntry?.name ?? "(未命名)",
    hasFile: fileId !== null,
    recognitionMode,
  };
}

export function OcrBulkActions() {
  const { allText, fileLabel, hasFile, recognitionMode } = useBulkOcrText();
  const [copied, setCopied] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const hasAllText = allText.length > 0;

  const onCopyAll = useCallback(async () => {
    if (!allText) return;
    try {
      await writeText(allText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setSaveError(`复制失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [allText]);

  const onSaveAll = useCallback(async () => {
    if (!allText) return;
    setSaveError(null);
    try {
      const stem = fileLabel.replace(/\.[^.]+$/, "");
      const defaultName =
        recognitionMode === "whole_file"
          ? `${stem}_全文按页.txt`
          : `${stem}_全部报道.txt`;
      const target = await save({
        defaultPath: defaultName,
        filters: [{ name: "文本", extensions: ["txt", "md"] }],
      });
      if (!target) return;
      await writeTextFile(target, allText);
    } catch (e) {
      setSaveError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [allText, fileLabel, recognitionMode]);

  if (!hasFile) return null;

  return (
    <div className="flex shrink-0 items-center gap-1">
      {copied && (
        <Check
          className="h-3 w-3 text-foreground-muted"
          strokeWidth={1.9}
          aria-label="已复制"
        />
      )}
      {saveError && (
        <span className="max-w-24 truncate text-[10px] text-destructive">
          {saveError}
        </span>
      )}
      <button
        type="button"
        disabled={!hasAllText}
        onClick={() => void onCopyAll()}
        title={recognitionMode === "whole_file" ? "复制所有页" : "复制所有报道"}
        aria-label={
          recognitionMode === "whole_file" ? "复制所有页" : "复制所有报道"
        }
        className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
      >
        <Files className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        disabled={!hasAllText}
        onClick={() => void onSaveAll()}
        title={recognitionMode === "whole_file" ? "导出所有页" : "导出所有报道"}
        aria-label={
          recognitionMode === "whole_file" ? "导出所有页" : "导出所有报道"
        }
        className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
      >
        <FileDown className="h-3.5 w-3.5" strokeWidth={1.75} />
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
  const files = useStore((s) => s.files);
  const prevPage = useStore((s) => s.prevPage);
  const nextPage = useStore((s) => s.nextPage);

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
  const pageText = fileId ? pageOcrTexts[fileId]?.[currentPage] ?? "" : "";

  const text = recognitionMode === "whole_file" ? pageText : articleText;
  const charCount = text.length;
  const hasText = text.length > 0;

  const [draft, setDraft] = useState(text);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [copied, setCopied] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    setDraft(text);
  }, [text, fileId, recognitionMode, pinnedArticle?.article.id, currentPage]);

  const onCopy = useCallback(async () => {
    try {
      await writeText(draftRef.current);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setSaveError(`复制失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const onSave = useCallback(async () => {
    setSaveError(null);
    try {
      const stem = fileLabel.replace(/\.[^.]+$/, "");
      const defaultName =
        recognitionMode === "whole_file"
          ? hasMultiplePages
            ? `${stem}_第${currentPage}页.txt`
            : `${stem}.txt`
          : pinnedArticle
            ? `${stem}_${pinnedArticle.article.title || `报道${pinnedArticle.article.num}`}.txt`
            : `${stem}.txt`;
      const target = await save({
        defaultPath: defaultName,
        filters: [{ name: "文本", extensions: ["txt", "md"] }],
      });
      if (!target) return;
      await writeTextFile(target, draftRef.current);
    } catch (e) {
      setSaveError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [fileLabel, recognitionMode, pinnedArticle, hasMultiplePages, currentPage]);

  const titleLabel =
    recognitionMode === "whole_file"
      ? `第 ${currentPage} 页`
      : pinnedArticle
        ? pinnedArticle.article.title || `报道${pinnedArticle.article.num}`
        : "全文";

  const atFirst = currentPage <= 1;
  const atLast = currentPage >= totalPages;

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 px-2 pt-2 pb-1">
      <div className="flex items-center justify-between gap-2 px-1.5">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
          {recognitionMode === "whole_file" && hasMultiplePages ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={prevPage}
                disabled={atFirst}
                aria-label="上一页"
                className={cn(
                  "grid h-5 w-5 place-items-center rounded transition-colors",
                  atFirst
                    ? "text-foreground-subtle/40"
                    : "text-foreground-subtle hover:bg-surface-2 hover:text-foreground"
                )}
              >
                <ChevronLeft className="h-3 w-3" strokeWidth={1.8} />
              </button>
              <span className="font-mono text-[11px] tabular-nums text-foreground-muted">
                第 {currentPage} / {totalPages} 页
              </span>
              <button
                type="button"
                onClick={nextPage}
                disabled={atLast}
                aria-label="下一页"
                className={cn(
                  "grid h-5 w-5 place-items-center rounded transition-colors",
                  atLast
                    ? "text-foreground-subtle/40"
                    : "text-foreground-subtle hover:bg-surface-2 hover:text-foreground"
                )}
              >
                <ChevronRight className="h-3 w-3" strokeWidth={1.8} />
              </button>
            </div>
          ) : (
            <span className="truncate font-medium text-foreground-muted">
              {titleLabel}
            </span>
          )}
          {hasText && (
            <span className="font-mono text-foreground-subtle tabular-nums">
              {charCount.toLocaleString()}
            </span>
          )}
        </div>
        {hasText && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5">
            {copied && (
              <span className="text-[10px] text-foreground-muted">已复制 ✓</span>
            )}
            <button
              type="button"
              onClick={() => setEditMode((v) => !v)}
              title={editMode ? "预览" : "编辑源码"}
              aria-label={editMode ? "切换到预览" : "切换到源码"}
              className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground"
            >
              {editMode ? (
                <Eye className="h-3 w-3" strokeWidth={1.75} />
              ) : (
                <FileCode className="h-3 w-3" strokeWidth={1.75} />
              )}
            </button>
            <button
              type="button"
              onClick={() => void onCopy()}
              title="复制"
              aria-label="复制"
              className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground"
            >
              <Copy className="h-3 w-3" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={() => void onSave()}
              title="保存"
              aria-label="保存"
              className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground"
            >
              <Download className="h-3 w-3" strokeWidth={1.75} />
            </button>
          </div>
        )}
      </div>

      {saveError && (
        <p className="px-1.5 text-[10px] text-destructive" role="alert">
          {saveError}
        </p>
      )}

      {hasText ? (
        editMode ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none rounded-md border border-border/40 bg-background px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-foreground outline-none focus:border-border-strong"
          />
        ) : (
          <div className="prose-ocr min-h-0 flex-1 overflow-auto rounded-md border border-border/40 bg-background px-3 py-2">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
            >
              {draft}
            </ReactMarkdown>
          </div>
        )
      ) : (
        <div className="min-h-0 flex-1 rounded-md border border-dashed border-border/50" />
      )}
    </div>
  );
}
