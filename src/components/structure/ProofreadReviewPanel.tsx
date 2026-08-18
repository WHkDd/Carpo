import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Pencil, X } from "lucide-react";
import { useStore } from "@/store";
import { useT, type Translator } from "@/i18n";
import { confirmDestructive } from "@/lib/confirm";
import { isImeCommit } from "@/lib/ime";
import { cn } from "@/lib/utils";
import type { ProofreadCategory } from "@/lib/ipc-types";
import type { LayoutPage } from "@/lib/layout-document";
import { articleRectsByPage } from "@/lib/article-bbox";
import {
  appliedSuggestionCount,
  categoryVerdictState,
  findBlockIndexForSuggestion,
  type ProofreadReview,
} from "@/lib/proofread";
import { proofreadTargetText } from "@/store/jobSlice";

const CATEGORY_ORDER: ProofreadCategory[] = [
  "punct",
  "charform",
  "garble",
  "layout",
  "semantic",
];

function categoryLabel(category: ProofreadCategory, t: Translator): string {
  return t(`proofread.category.${category}`);
}

interface ProofreadReviewPanelProps {
  fileId: string;
  /** The opaque wire key (`page:12` / `article:a_xxx`) this review belongs
   *  to — used as the store key, not parsed here. */
  targetKey: string;
  review: ProofreadReview;
  /** Escape / the back button leave the review; verdicts stay untouched. */
  onClose: () => void;
  /** Re-runs the proofread over this target's live text (the stale banner's
   *  only forward path). */
  onReProofread: () => void;
}

/**
 * The inline diff view for one proofread unit. Deliberately not a modal:
 * judging a correction means looking at the scan, and a dialog would cover
 * the canvas the whole feature exists to keep visible.
 */
export function ProofreadReviewPanel({
  fileId,
  targetKey,
  review,
  onClose,
  onReProofread,
}: ProofreadReviewPanelProps) {
  const t = useT();
  const currentText = useStore((s) =>
    proofreadTargetText(s, fileId, review.target)
  );
  const layout = useStore(
    (s): LayoutPage | undefined =>
      review.target.mode === "whole_file"
        ? s.recognizedPages[fileId]?.[review.target.page]?.layout
        : undefined
  );
  const setSuggestionVerdict = useStore((s) => s.setProofreadSuggestionVerdict);
  const setCategoryVerdict = useStore((s) => s.setProofreadCategoryVerdict);
  const applyReview = useStore((s) => s.applyProofreadReview);
  const undoReview = useStore((s) => s.undoProofreadReview);
  const discardReview = useStore((s) => s.discardProofreadReview);
  const setEditingLayoutBlock = useStore((s) => s.setEditingLayoutBlock);
  const setFocusedRegion = useStore((s) => s.setFocusedRegion);

  const suggestions = review.suggestions;
  const [selectedIndex, setSelectedIndex] = useState<number | null>(
    suggestions.length > 0 ? 0 : null
  );
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  // Set by cancelEdit so the input's own unmount-blur does not commit the
  // edit the user just abandoned.
  const cancelBlurRef = useRef(false);

  const targetGone = currentText === null;
  const liveText = currentText ?? "";
  const stale =
    review.status === "pending" && review.error === undefined &&
    (targetGone || liveText !== review.baseText);
  const appliedCount = appliedSuggestionCount(suggestions);
  const undoBlocked =
    review.status === "applied" &&
    review.appliedText !== undefined &&
    liveText !== review.appliedText;

  const rowRefs = useRef<Array<HTMLLIElement | null>>([]);
  useEffect(() => {
    if (selectedIndex !== null) {
      // jsdom has no layout engine; the guard keeps the jsdom test env
      // working without a stub.
      rowRefs.current[selectedIndex]?.scrollIntoView?.({ block: "nearest" });
    }
  }, [selectedIndex]);

  // Canvas linkage: the *selected* suggestion lights up where it lives on the
  // page and brings it into view (via ImageCanvas's `revealRect`).
  //
  // Two precisions, because the two modes recognize text differently. A
  // whole-file page has per-block layout, so the suggestion is traced to the
  // exact block. A grouped article is recognized as one piece — there is no
  // per-block geometry inside it — so the best available answer is the
  // article's own outline, which every suggestion in that review shares.
  // Coarser, but pointing at the right report beats pointing nowhere.
  //
  // Every branch that does *not* end in a highlight has to clear the previous
  // one. Bailing out early instead would leave the canvas pointing at
  // whatever the last locatable suggestion was — a highlight that now
  // contradicts the selected row, which is worse than no highlight at all.
  useEffect(() => {
    const clearHighlight = () => {
      setEditingLayoutBlock(fileId, null);
      setFocusedRegion(fileId, null);
    };
    if (selectedIndex === null || !suggestions[selectedIndex]) {
      clearHighlight();
      return;
    }
    if (review.target.mode === "grouped") {
      // Read at effect time rather than subscribed: the blocks of the article
      // under review do not move while it is being reviewed, and subscribing
      // to `pageStates` would re-run this on every unrelated block edit.
      const store = useStore.getState();
      // Read out of the narrowed target before the callback: narrowing does
      // not follow a property access into a closure.
      const articleId = review.target.articleId;
      const article = store
        .getDocumentState(fileId)
        .articles.find((candidate) => candidate.id === articleId);
      const rects = article
        ? articleRectsByPage(article, store.pageStates, fileId)
        : [];
      setEditingLayoutBlock(fileId, null);
      // An article whose blocks are all gone has nothing to point at — the
      // same "clear rather than mislead" rule as every other branch.
      setFocusedRegion(fileId, rects.length > 0 ? { rects } : null);
      return;
    }
    if (!layout) {
      clearHighlight();
      return;
    }
    const suggestion = suggestions[selectedIndex];
    const blockIndex = findBlockIndexForSuggestion(layout, suggestion);
    if (blockIndex === null) {
      clearHighlight();
      return;
    }
    const current = useStore
      .getState()
      .getEditingLayoutBlockIndex(fileId, review.target.page);
    if (current !== blockIndex) {
      setEditingLayoutBlock(fileId, {
        page: review.target.page,
        index: blockIndex,
      });
    }
  }, [
    fileId,
    layout,
    review.target,
    selectedIndex,
    suggestions,
    setEditingLayoutBlock,
    setFocusedRegion,
  ]);

  // The highlight exists only while the review is on screen.
  useEffect(
    () => () => {
      useStore.getState().setEditingLayoutBlock(fileId, null);
      useStore.getState().setFocusedRegion(fileId, null);
    },
    [fileId]
  );

  const setVerdict = useCallback(
    (index: number, verdict: "accepted" | "rejected") => {
      setSuggestionVerdict(fileId, targetKey, index, verdict);
    },
    [fileId, targetKey, setSuggestionVerdict]
  );

  const beginEdit = useCallback(
    (index: number) => {
      // Seed with the current proposed text so a hand edit starts from the
      // suggestion, not from scratch.
      const suggestion = suggestions[index];
      cancelBlurRef.current = false;
      setEditValue(
        suggestion?.verdict === "edited" && suggestion.editedAfter !== undefined
          ? suggestion.editedAfter
          : suggestion?.after ?? ""
      );
      setEditIndex(index);
    },
    [suggestions]
  );

  const commitEdit = useCallback(() => {
    if (cancelBlurRef.current) return;
    if (editIndex !== null) {
      setSuggestionVerdict(fileId, targetKey, editIndex, "edited", editValue);
      setEditIndex(null);
    }
  }, [editIndex, editValue, fileId, targetKey, setSuggestionVerdict]);

  const cancelEdit = useCallback(() => {
    // The input unmounts on cancel, which fires its blur — the flag stops
    // that blur from committing the edit the user just abandoned.
    cancelBlurRef.current = true;
    setEditIndex(null);
  }, []);

  // J/K move, A accept, R reject, E edit, Escape leaves. Bare letters are
  // safe because the review body is not a text field — and the moment one
  // exists (the E edit box) this handler steps aside entirely: the IME guard
  // and the editable-target check below are the two tripwires from §3.6.
  // The listener registers even for empty / errored reviews: Escape must
  // always work (#29), and an error review has no suggestions to act on but
  // still needs its exit.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isImeCommit(e) || e.defaultPrevented || e.metaKey || e.ctrlKey) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (suggestions.length === 0) return;
      if (editIndex !== null) return;
      const move = (delta: number) => {
        e.preventDefault();
        setSelectedIndex((current) => {
          const base = current ?? 0;
          const next = (base + delta + suggestions.length) % suggestions.length;
          return next;
        });
      };
      if (e.key === "j" || e.key === "J") {
        move(1);
      } else if (e.key === "k" || e.key === "K") {
        move(-1);
      } else if (e.key === "a" || e.key === "A") {
        if (selectedIndex !== null) {
          e.preventDefault();
          setVerdict(selectedIndex, "accepted");
        }
      } else if (e.key === "r" || e.key === "R") {
        if (selectedIndex !== null) {
          e.preventDefault();
          setVerdict(selectedIndex, "rejected");
        }
      } else if (e.key === "e" || e.key === "E") {
        if (selectedIndex !== null) {
          e.preventDefault();
          beginEdit(selectedIndex);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    suggestions.length,
    selectedIndex,
    editIndex,
    beginEdit,
    onClose,
    setVerdict,
  ]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<ProofreadCategory, number>();
    for (const s of suggestions) {
      counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    }
    return counts;
  }, [suggestions]);

  const handleDiscard = useCallback(async () => {
    const ok = await confirmDestructive({
      title: t("proofread.discardConfirmTitle"),
      message: t("proofread.discardConfirmBody"),
      confirmLabel: t("proofread.discard"),
    });
    if (!ok) return;
    discardReview(fileId, targetKey);
    onClose();
  }, [discardReview, fileId, targetKey, onClose, t]);

  const handleApply = useCallback(() => {
    // A stale review cannot apply (the action refuses and the banner above
    // already explains why); a missing target means the text is gone.
    applyReview(fileId, targetKey);
  }, [applyReview, fileId, targetKey]);

  const handleUndo = useCallback(() => {
    undoReview(fileId, targetKey);
  }, [undoReview, fileId, targetKey]);

  const header = (
    <div className="flex items-center gap-1.5 px-1.5">
      <button
        type="button"
        onClick={onClose}
        aria-label={t("proofread.backToPreview")}
        title={t("proofread.backToPreview")}
        className="grid h-6 w-6 place-items-center rounded text-foreground-muted hover:bg-surface-2 hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
      <span className="min-w-0 truncate text-[11px] font-medium text-foreground">
        {t("proofread.reviewTitle")}
      </span>
      {review.model && (
        <span
          className="min-w-0 truncate font-mono text-[10px] text-foreground-subtle"
          title={review.model}
        >
          {review.model}
        </span>
      )}
      <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-foreground-subtle">
        {suggestions.length.toLocaleString()}
      </span>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      {header}

      {review.error !== undefined ? (
        <div
          className="mx-1.5 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive"
          role="alert"
        >
          <p>{t("proofread.failed", { message: review.error })}</p>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              onClick={onReProofread}
              className="rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground hover:bg-surface-2"
            >
              {t("proofread.reProofread")}
            </button>
            <button
              type="button"
              onClick={() => void handleDiscard()}
              className="rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground hover:bg-surface-2"
            >
              {t("proofread.discard")}
            </button>
          </div>
        </div>
      ) : stale ? (
        // Stale means the base snapshot no longer matches the live text, so
        // every suggestion's character offsets are dead. Never silently
        // apply — that would overwrite the user's manual edits. The only
        // exits are a fresh run over the new text, or dropping the review.
        <div
          className="mx-1.5 rounded border border-border bg-surface-2 px-2 py-1.5 text-[11px] text-foreground"
          role="alert"
        >
          <p className="font-medium">{t("proofread.staleTitle")}</p>
          <p className="mt-0.5 text-foreground-muted">{t("proofread.staleBody")}</p>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              onClick={onReProofread}
              disabled={targetGone}
              className="rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground hover:bg-surface-2 disabled:cursor-default disabled:opacity-40"
            >
              {t("proofread.reProofread")}
            </button>
            <button
              type="button"
              onClick={() => void handleDiscard()}
              className="rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground hover:bg-surface-2"
            >
              {t("proofread.discard")}
            </button>
          </div>
        </div>
      ) : review.status === "applied" ? (
        <div
          className="mx-1.5 flex items-center gap-2 rounded border border-success/40 bg-success/10 px-2 py-1.5 text-[11px] text-foreground"
          role="status"
        >
          <span>{t("proofread.appliedNote")}</span>
          {(review.appliedConflictSkipped ?? 0) > 0 && (
            <span className="text-foreground-muted" role="status">
              {t("proofread.conflictSkippedNote", {
                count: review.appliedConflictSkipped ?? 0,
              })}
            </span>
          )}
          {undoBlocked && (
            <span
              className="text-foreground-muted"
              title={t("proofread.undoBlocked")}
            >
              {t("proofread.undoBlocked")}
            </span>
          )}
        </div>
      ) : null}

      {review.discarded > 0 && review.error === undefined && (
        <p className="px-1.5 text-[10px] text-foreground-subtle" role="status">
          {t("proofread.discardedNote", { count: review.discarded })}
        </p>
      )}

      {suggestions.length === 0 ? (
        review.error === undefined && (
          <div className="mx-1.5 flex min-h-0 flex-1 flex-col gap-2 rounded-md border border-dashed border-border/50 bg-background/35 p-3">
            <p className="text-[12px] text-foreground-muted">
              {t("proofread.empty")}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground hover:bg-surface-2"
              >
                {t("proofread.backToPreview")}
              </button>
              <button
                type="button"
                onClick={() => void handleDiscard()}
                className="rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground hover:bg-surface-2"
              >
                {t("proofread.discard")}
              </button>
            </div>
          </div>
        )
      ) : (
        <>
          {/* Category toolbar: one chip per category with a count. The chip
              is a batch toggle — click to flip the whole category between
              accept-all and reject-all. */}
          <div className="flex flex-wrap items-center gap-1 px-1.5">
            {CATEGORY_ORDER.filter((c) => (categoryCounts.get(c) ?? 0) > 0).map(
              (category) => {
                const count = categoryCounts.get(category) ?? 0;
                const allAccepted =
                  categoryVerdictState(suggestions, category) === "accept-all";
                return (
                  <button
                    key={category}
                    type="button"
                    onClick={() =>
                      setCategoryVerdict(
                        fileId,
                        targetKey,
                        category,
                        allAccepted ? "rejected" : "accepted"
                      )
                    }
                    className={cn(
                      "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] transition-colors",
                      allAccepted
                        ? "border-success/40 bg-success/10 text-success"
                        : "border-border bg-surface-2 text-foreground-muted"
                    )}
                  >
                    <span>{categoryLabel(category, t)}</span>
                    <span className="font-mono tabular-nums">{count}</span>
                  </button>
                );
              }
            )}
          </div>

          <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-1.5">
            {suggestions.map((suggestion, index) => {
              const selected = index === selectedIndex;
              const accepted = suggestion.verdict === "accepted";
              const rejected = suggestion.verdict === "rejected";
              const edited = suggestion.verdict === "edited";
              const displayAfter =
                edited && suggestion.editedAfter !== undefined
                  ? suggestion.editedAfter
                  : suggestion.after;
              const isEditing = editIndex === index;

              return (
                <li
                  key={index}
                  ref={(node) => {
                    rowRefs.current[index] = node;
                  }}
                  tabIndex={selected ? 0 : -1}
                  onFocus={() => setSelectedIndex(index)}
                  aria-label={t("proofread.suggestionAria", {
                    before: suggestion.before,
                    after:
                      displayAfter.length > 0
                        ? displayAfter
                        : t("proofread.deleteOnly"),
                    category: categoryLabel(suggestion.category, t),
                  })}
                  className={cn(
                    "rounded-md border px-2 py-1.5 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    selected
                      ? "border-border-strong bg-surface-2"
                      : "border-border/40 bg-background",
                    rejected && "opacity-50"
                  )}
                >
                  <div className="flex items-start gap-1.5 text-[12px] leading-relaxed">
                    {suggestion.context_before && (
                      <span className="max-w-[45%] truncate text-foreground-subtle">
                        {suggestion.context_before}
                      </span>
                    )}
                    <span
                      className={cn(
                        "break-all",
                        rejected
                          ? "text-foreground"
                          : "text-destructive line-through decoration-destructive/70"
                      )}
                    >
                      {suggestion.before}
                    </span>
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (isImeCommit(e)) return;
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitEdit();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelEdit();
                          }
                        }}
                        onBlur={commitEdit}
                        aria-label={t("proofread.edit")}
                        className="h-5 min-w-0 flex-1 rounded border border-border-strong bg-background px-1 font-mono text-[11.5px] text-foreground outline-none"
                      />
                    ) : (
                      <span
                        className={cn(
                          "break-all",
                          edited || accepted
                            ? "font-medium text-success"
                            : "text-foreground-muted"
                        )}
                      >
                        {displayAfter.length > 0
                          ? displayAfter
                          : `〔${t("proofread.deleteOnly")}〕`}
                      </span>
                    )}
                    <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-1">
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() => {
                          if (isEditing) commitEdit();
                          else setVerdict(index, "accepted");
                        }}
                        aria-label={t("proofread.accept")}
                        aria-pressed={accepted}
                        className={cn(
                          "grid h-5 w-5 place-items-center rounded",
                          accepted
                            ? "text-success"
                            : "text-foreground-subtle hover:bg-surface-2 hover:text-foreground"
                        )}
                      >
                        <Check className="h-3 w-3" strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() => {
                          if (isEditing) cancelEdit();
                          else setVerdict(index, "rejected");
                        }}
                        aria-label={t("proofread.reject")}
                        aria-pressed={rejected}
                        className={cn(
                          "grid h-5 w-5 place-items-center rounded",
                          rejected
                            ? "text-destructive"
                            : "text-foreground-subtle hover:bg-surface-2 hover:text-foreground"
                        )}
                      >
                        <X className="h-3 w-3" strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() =>
                          isEditing ? cancelEdit() : beginEdit(index)
                        }
                        aria-label={t("proofread.edit")}
                        aria-pressed={isEditing}
                        className={cn(
                          "grid h-5 w-5 place-items-center rounded",
                          edited
                            ? "text-success"
                            : "text-foreground-subtle hover:bg-surface-2 hover:text-foreground"
                        )}
                      >
                        <Pencil className="h-3 w-3" strokeWidth={1.75} />
                      </button>
                    </span>
                  </div>
                  <p className="mt-0.5 truncate pl-0.5 text-[10px] text-foreground-subtle">
                    <span className="rounded bg-surface-2 px-1 py-px text-foreground-muted">
                      {categoryLabel(suggestion.category, t)}
                    </span>
                    {suggestion.reason && (
                      <span className="ml-1.5" title={suggestion.reason}>
                        {suggestion.reason}
                      </span>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="flex shrink-0 items-center gap-2 px-1.5 pb-0.5">
        {/* The hint is the flexible party here: it wraps to more lines at
            narrow widths so the action buttons never get squeezed into
            vertical text. */}
        <span className="min-w-0 text-[10px] text-foreground-subtle">
          {t("proofread.keyboardHint")}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {review.status !== "applied" && (
            <button
              type="button"
              onClick={() => void handleDiscard()}
              className="h-7 whitespace-nowrap rounded border border-border bg-background px-2 text-[11.5px] text-foreground hover:bg-surface-2"
            >
              {t("proofread.discard")}
            </button>
          )}
          {review.status === "applied" ? (
            <button
              type="button"
              onClick={handleUndo}
              disabled={undoBlocked}
              title={undoBlocked ? t("proofread.undoBlocked") : undefined}
              className="h-7 whitespace-nowrap rounded border border-border bg-background px-2 text-[11.5px] text-foreground hover:bg-surface-2 disabled:cursor-default disabled:opacity-40"
            >
              {t("proofread.undo")}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleApply}
              disabled={
                appliedCount === 0 || stale || review.error !== undefined
              }
              className="h-7 whitespace-nowrap rounded bg-primary px-2.5 text-[11.5px] font-medium text-primary-foreground transition-opacity hover:bg-primary/90 disabled:cursor-default disabled:opacity-50"
            >
              {t("proofread.apply", { count: appliedCount })}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
