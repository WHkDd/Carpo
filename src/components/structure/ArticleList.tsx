import { useCallback, useMemo, useRef, useState } from "react";
import { useStore } from "@/store";
import { Pencil, Trash2 } from "lucide-react";
import { articleHsl } from "@/lib/article-color-token";

interface ArticleRowProps {
  num: number;
  title: string;
  totalBlocks: number;
  pageBlocks: number;
  color: string;
  hasOcr: boolean;
  isSelected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onUpdateTitle: (title: string) => void;
  onRemove: () => void;
}

function ArticleRow({
  num,
  title,
  totalBlocks,
  pageBlocks,
  color,
  hasOcr,
  isSelected,
  onClick,
  onUpdateTitle,
  onRemove,
}: ArticleRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const startEdit = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setDraft(title);
      setIsEditing(true);
    },
    [title]
  );

  const saveEdit = useCallback(() => {
    onUpdateTitle(draft.trim());
    setIsEditing(false);
  }, [draft, onUpdateTitle]);

  return (
    <div
      onClick={onClick}
      className={`group flex cursor-pointer items-start gap-2 rounded-lg border px-2 py-1.5 transition-colors ${
        isSelected
          ? "border-border-strong bg-surface-2"
          : "border-transparent hover:bg-surface-2/60"
      }`}
    >
      <div
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{ backgroundColor: color }}
      >
        {num}
      </div>

      <div className="min-w-0 flex-1">
        {isEditing ? (
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveEdit();
              if (e.key === "Escape") setIsEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            onBlur={saveEdit}
            autoFocus
            className="h-6 w-full rounded border border-border/60 bg-background px-1.5 text-[12px] outline-none focus:border-border-strong"
          />
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[12px] font-medium text-foreground">
                {title}
              </span>
              {hasOcr && (
                <span
                  aria-hidden
                  title="已识别"
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70"
                />
              )}
            </div>
            <div className="text-[10px] text-foreground-subtle">
              {totalBlocks} 版块
              {pageBlocks > 0 && pageBlocks < totalBlocks
                ? ` · ${pageBlocks} 在当前页`
                : ""}
            </div>
          </>
        )}
      </div>

      {!isEditing && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={startEdit}
            className="flex h-6 w-6 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-2"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-foreground-subtle hover:text-destructive hover:bg-surface-2"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

export function ArticleList() {
  const fileId = useStore((s) => s.currentFileId) ?? "";
  const articles = useStore((s) => s.getDocumentState(fileId).articles);
  const currentPage = useStore((s) => {
    const file = s.files.find((f) => f.id === fileId);
    return file?.currentPage ?? 1;
  });
  const selectedArticleIds = useStore((s) => s.selectedArticleIds);
  const setSelectedArticleIds = useStore((s) => s.setSelectedArticleIds);
  const toggleArticleSelection = useStore((s) => s.toggleArticleSelection);
  const clearArticleSelection = useStore((s) => s.clearArticleSelection);
  const updateArticle = useStore((s) => s.updateArticle);
  const removeArticle = useStore((s) => s.removeArticle);
  const clearArticles = useStore((s) => s.clearArticles);
  const articleOcrTexts = useStore((s) =>
    fileId ? s.articleOcrTexts[fileId] : undefined
  );

  const selectedSet = useMemo(
    () => new Set(selectedArticleIds),
    [selectedArticleIds]
  );

  // Anchor for shift-click range selection. Tracks the most recently
  // clicked (non-shift) row so a follow-up shift-click can extend from
  // there. Cleared whenever the article list itself changes shape.
  const anchorIdRef = useRef<string | null>(null);

  const pageBlockCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const article of articles) {
      const count = article.blockRefs.filter(
        (ref) => ref.page === currentPage
      ).length;
      counts.set(article.id, count);
    }
    return counts;
  }, [articles, currentPage]);

  const handleClearAll = useCallback(() => {
    if (articles.length === 0) return;
    if (window.confirm(`确定清除全部 ${articles.length} 篇报道？`)) {
      clearArticles(fileId);
      clearArticleSelection();
      anchorIdRef.current = null;
    }
  }, [articles.length, fileId, clearArticles, clearArticleSelection]);

  const handleRowClick = useCallback(
    (articleId: string, e: React.MouseEvent) => {
      const additive = e.metaKey || e.ctrlKey;
      const range = e.shiftKey;
      if (range && anchorIdRef.current && articles.length > 0) {
        const ids = articles.map((a) => a.id);
        const anchorIdx = ids.indexOf(anchorIdRef.current);
        const targetIdx = ids.indexOf(articleId);
        if (anchorIdx >= 0 && targetIdx >= 0) {
          const [lo, hi] =
            anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
          setSelectedArticleIds(ids.slice(lo, hi + 1));
          return;
        }
      }
      anchorIdRef.current = articleId;
      toggleArticleSelection(articleId, additive);
    },
    [articles, setSelectedArticleIds, toggleArticleSelection]
  );

  if (!fileId) return null;

  const allSelected =
    articles.length > 0 && articles.every((a) => selectedSet.has(a.id));

  return (
    <div className="flex flex-col gap-1">
      {articles.length > 0 && (
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-foreground-subtle">
            {selectedSet.size > 0 && (
              <span className="font-mono text-foreground-muted">
                ({selectedSet.size}/{articles.length})
              </span>
            )}
          </span>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() =>
                allSelected
                  ? clearArticleSelection()
                  : setSelectedArticleIds(articles.map((a) => a.id))
              }
              className="text-[11px] text-foreground-muted hover:text-foreground"
            >
              {allSelected ? "取消全选" : "全选"}
            </button>
            <button
              type="button"
              onClick={handleClearAll}
              className="text-[11px] text-destructive hover:opacity-80"
            >
              全清
            </button>
          </div>
        </div>
      )}

      {articles.length === 0 ? (
        <div className="rounded-lg border border-border/40 px-3 py-6 text-center text-[11px] text-foreground-subtle">
          尚未标记报道
        </div>
      ) : (
        articles.map((article) => {
          const pageCount = pageBlockCounts.get(article.id) ?? 0;
          const isSelected = selectedSet.has(article.id);
          const color = articleHsl(article.num, 1);

          return (
            <ArticleRow
              key={article.id}
              num={article.num}
              title={article.title}
              totalBlocks={article.blockRefs.length}
              pageBlocks={pageCount}
              color={color}
              hasOcr={(articleOcrTexts?.[article.id] ?? "").length > 0}
              isSelected={isSelected}
              onClick={(e) => handleRowClick(article.id, e)}
              onUpdateTitle={(title) =>
                updateArticle(fileId, article.id, { title })
              }
              onRemove={() => {
                removeArticle(fileId, article.id);
                if (isSelected) {
                  setSelectedArticleIds(
                    selectedArticleIds.filter((id) => id !== article.id)
                  );
                }
              }}
            />
          );
        })
      )}
    </div>
  );
}
