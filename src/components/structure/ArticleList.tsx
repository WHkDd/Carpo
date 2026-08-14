import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "@/store";
import { Pencil, Trash2 } from "lucide-react";
import { isRowCommandTarget, useListKeyboard } from "@/hooks/useListKeyboard";
import { articleHsl } from "@/lib/article-color-token";
import { isImeCommit } from "@/lib/ime";
import { confirmDestructive } from "@/lib/confirm";
import { useT } from "@/i18n";

interface ArticleRowProps {
  num: number;
  title: string;
  totalBlocks: number;
  pageBlocks: number;
  color: string;
  hasOcr: boolean;
  isSelected: boolean;
  tabbable: boolean;
  isEditing: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
  onClick: (e: React.MouseEvent) => void;
  onUpdateTitle: (title: string) => void;
  onRemove: () => void;
}

/** Row commands are hover-revealed, which used to mean a keyboard user could
 *  focus a control they could not see. `group-focus-within` brings them out
 *  whenever anything inside the row has focus. */
const ROW_COMMAND =
  "flex h-6 w-6 items-center justify-center rounded text-foreground-subtle hover:bg-surface-2 active:bg-surface-overlay focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

const ArticleRow = forwardRef<HTMLDivElement, ArticleRowProps>(function ArticleRow(
  {
    num,
    title,
    totalBlocks,
    pageBlocks,
    color,
    hasOcr,
    isSelected,
    tabbable,
    isEditing,
    onStartEdit,
    onEndEdit,
    onClick,
    onUpdateTitle,
    onRemove,
  },
  ref
) {
  const t = useT();
  const [draft, setDraft] = useState(title);

  // Re-seed the draft each time the row enters edit mode; editing state now
  // lives in the parent so the list can suspend its own key handling.
  useEffect(() => {
    if (isEditing) setDraft(title);
  }, [isEditing, title]);

  const saveEdit = useCallback(() => {
    onUpdateTitle(draft.trim());
    onEndEdit();
  }, [draft, onEndEdit, onUpdateTitle]);

  return (
    // A grid row, not a listbox option: the row carries inline commands, and
    // ARIA lets a listbox own only options — which left those buttons as
    // children the container was not allowed to have and no arrow key could
    // reach. Selection cell first, then one cell per command.
    <div
      role="row"
      aria-selected={isSelected}
      className={`group flex items-start gap-2 rounded-lg border px-2 py-1.5 transition-colors ${
        isSelected
          ? "border-border-strong bg-surface-2"
          : "border-transparent hover:bg-surface-2/60"
      }`}
    >
      <div
        ref={ref}
        role="gridcell"
        tabIndex={tabbable && !isEditing ? 0 : -1}
        onClick={onClick}
        className="flex min-w-0 flex-1 items-start gap-2 rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <div
          aria-hidden
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
              aria-label={t("article.editTitle")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter during composition picks an IME candidate; committing
                // here would store the raw pinyin and close the editor.
                if (isImeCommit(e)) return;
                e.stopPropagation();
                if (e.key === "Enter") saveEdit();
                if (e.key === "Escape") onEndEdit();
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
                    title={t("article.recognized")}
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70"
                  />
                )}
              </div>
              <div className="text-[10px] text-foreground-subtle">
                {t("article.blocks", { count: totalBlocks })}
                {pageBlocks > 0 && pageBlocks < totalBlocks
                  ? t("article.blocksOnPage", { count: pageBlocks })
                  : ""}
              </div>
            </>
          )}
        </div>
      </div>

      {!isEditing && (
        <div
          role="gridcell"
          className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label={t("article.editTitle")}
            title={t("article.editTitle")}
            onClick={(e) => {
              e.stopPropagation();
              onStartEdit();
            }}
            className={`${ROW_COMMAND} hover:text-foreground`}
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t("article.removeNamed", { title })}
            title={t("common.delete")}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className={`${ROW_COMMAND} hover:text-destructive`}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
});

export function ArticleList() {
  const t = useT();
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
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  // Which row is in title-edit mode. Hoisted out of the row so the list can
  // stand down while the user is typing — otherwise every keystroke in the
  // title field would also drive type-ahead.
  const [editingId, setEditingId] = useState<string | null>(null);

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

  const handleClearAll = useCallback(async () => {
    if (articles.length === 0) return;
    const ok = await confirmDestructive({
      title: t("article.clearAll"),
      message: t("article.confirmClear", { count: articles.length }),
    });
    if (!ok) return;
    clearArticles(fileId);
    clearArticleSelection();
    anchorIdRef.current = null;
  }, [articles.length, fileId, clearArticles, clearArticleSelection, t]);

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

  // Keyboard selection is single-select: the last row the user landed on.
  // Multi-select stays a pointer gesture (⌘-click / shift-click).
  const keyboardIndex = articles.findIndex(
    (a) => a.id === selectedArticleIds[selectedArticleIds.length - 1]
  );

  const removeArticleAt = useCallback(
    (index: number) => {
      const article = articles[index];
      if (!article) return;
      removeArticle(fileId, article.id);
      setSelectedArticleIds(
        selectedArticleIds.filter((id) => id !== article.id)
      );
    },
    [articles, fileId, removeArticle, selectedArticleIds, setSelectedArticleIds]
  );

  const { onKeyDown } = useListKeyboard({
    itemCount: articles.length,
    activeIndex: keyboardIndex,
    onSelect: useCallback(
      (index: number) => {
        const article = articles[index];
        if (!article) return;
        anchorIdRef.current = article.id;
        setSelectedArticleIds([article.id]);
      },
      [articles, setSelectedArticleIds]
    ),
    labelAt: useCallback(
      (index: number) => articles[index]?.title ?? "",
      [articles]
    ),
    focusAt: useCallback((index: number) => rowRefs.current[index]?.focus(), []),
  });

  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // While a title is being edited the row owns the keyboard entirely —
      // including every letter, which would otherwise trigger type-ahead.
      if (editingId !== null) return;
      // Once → has moved focus onto a row command, that button owns Enter and
      // Space. Without this, Delete on the focused rename button would still
      // delete the article.
      if (isRowCommandTarget(e.target)) {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
          if (e.key === "Enter" || e.key === " ") return;
          if (e.key === "Delete" || e.key === "Backspace") return;
        }
        onKeyDown(e);
        return;
      }
      if (e.key === "Enter" || e.key === "F2") {
        const article = articles[keyboardIndex];
        if (article) {
          e.preventDefault();
          setEditingId(article.id);
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (keyboardIndex >= 0) {
          e.preventDefault();
          removeArticleAt(keyboardIndex);
        }
        return;
      }
      onKeyDown(e);
    },
    [articles, editingId, keyboardIndex, onKeyDown, removeArticleAt]
  );

  const tabbableIndex = keyboardIndex >= 0 ? keyboardIndex : 0;

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
              className="rounded text-[11px] text-foreground-muted hover:text-foreground focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {allSelected ? t("article.deselectAll") : t("article.selectAll")}
            </button>
            <button
              type="button"
              onClick={() => void handleClearAll()}
              className="rounded text-[11px] text-destructive hover:opacity-80 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {t("article.clearAll")}
            </button>
          </div>
        </div>
      )}

      {articles.length === 0 ? (
        <div className="rounded-lg border border-border/40 px-3 py-6 text-center text-[11px] text-foreground-subtle">
          {t("article.empty")}
        </div>
      ) : (
        <div
          role="grid"
          aria-label={t("rail.groupedTitle")}
          aria-multiselectable
          onKeyDown={onListKeyDown}
          className="flex flex-col gap-1"
        >
          {articles.map((article, index) => {
            const pageCount = pageBlockCounts.get(article.id) ?? 0;
            const isSelected = selectedSet.has(article.id);
            const color = articleHsl(article.num, 1);

            return (
              <ArticleRow
                key={article.id}
                ref={(node) => {
                  rowRefs.current[index] = node;
                }}
                num={article.num}
                title={article.title}
                totalBlocks={article.blockRefs.length}
                pageBlocks={pageCount}
                color={color}
                hasOcr={(articleOcrTexts?.[article.id] ?? "").length > 0}
                isSelected={isSelected}
                tabbable={index === tabbableIndex}
                isEditing={editingId === article.id}
                onStartEdit={() => setEditingId(article.id)}
                onEndEdit={() => {
                  setEditingId(null);
                  // Put focus back on the row, not on <body>, so arrow keys
                  // keep working straight after a rename.
                  window.requestAnimationFrame(() =>
                    rowRefs.current[index]?.focus()
                  );
                }}
                onClick={(e) => handleRowClick(article.id, e)}
                onUpdateTitle={(title) =>
                  updateArticle(fileId, article.id, { title })
                }
                onRemove={() => removeArticleAt(index)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
