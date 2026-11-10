import { forwardRef } from "react";
import { Check, FileText, FileImage, FileWarning, Star } from "lucide-react";
import type { FileEntry } from "@/lib/ipc-types";
import { ACTIVE_ROW, cn } from "@/lib/utils";
import { useStore } from "@/store";
import { useT } from "@/i18n";
import type { SearchRange } from "@/lib/queue-search";

/** Stable fallback: a fresh `[]` per call would re-render (zustand v5
 *  compares selector results by reference). */
const NO_TAGS: string[] = [];
const MAX_VISIBLE_TAGS = 2;

interface QueueItemProps {
  entry: FileEntry;
  active: boolean;
  /** Roving tabindex: exactly one row in the list is tabbable at a time, so
   *  the whole queue costs one Tab press to reach and is then traversed with
   *  the arrow keys — the platform's list model, not a form's. */
  tabbable: boolean;
  onSelect: (id: string, event: React.MouseEvent<HTMLDivElement>) => void;
  nameRanges?: SearchRange[];
  newspaperRanges?: SearchRange[];
  /** Batch-export selection mode: defined → the icon slot shows a checkbox
   *  in this state. The checkbox toggles via `onToggleCheck`; the rest of
   *  the row still opens the file, so dates can be filled in one by one
   *  without leaving the selection. */
  checked?: boolean;
  onToggleCheck?: (id: string) => void;
}

/** Focus styling shared by both densities and by the row commands.
 *  `focus-visible` only, so a mouse click doesn't leave a ring behind but
 *  keyboard navigation is never invisible. */
const CELL_FOCUS =
  "focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

export const QueueItem = forwardRef<HTMLDivElement, QueueItemProps>(
  function QueueItem(
    {
      entry,
      active,
      tabbable,
      onSelect,
      checked,
      onToggleCheck,
      nameRanges,
      newspaperRanges,
    },
    ref,
  ) {
    const t = useT();
    const tags = useStore((s) => s.documentStates[entry.id]?.tags ?? NO_TAGS);
    const newspaper = useStore(
      (s) => s.documentStates[entry.id]?.newspaperName ?? "",
    );
    const failed = !!entry.loadError;
    const Icon = failed
      ? FileWarning
      : entry.kind === "pdf"
        ? FileText
        : FileImage;
    const meta = failed ? t("queue.loadFailed") : entry.ext.toUpperCase();
    // The extension already shows on the meta line below, so the title drops
    // it. A failed row shows 无法读取 there instead and keeps the full name.
    const suffix = `.${entry.ext}`;
    const displayName =
      !failed &&
      entry.name.length > suffix.length &&
      entry.name.toLowerCase().endsWith(suffix.toLowerCase())
        ? entry.name.slice(0, -suffix.length)
        : entry.name;
    const pageBadge =
      entry.kind === "pdf" && (entry.pdfTotal ?? 1) > 1
        ? `${entry.currentPage ?? 1} / ${entry.pdfTotal}`
        : null;

    return (
      <div className="group relative" role="row" aria-selected={active}>
        <div
          ref={ref}
          role="gridcell"
          tabIndex={tabbable ? 0 : -1}
          onClick={(event) => onSelect(entry.id, event)}
          // Full reason on hover; the canvas shows it in full once selected.
          title={entry.loadError ?? undefined}
          className={cn(
            "grid w-full grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-100",
            CELL_FOCUS,
            active ? ACTIVE_ROW : "text-foreground-muted",
          )}
        >
          <span className="grid h-11 w-[34px] place-items-center rounded-lg border border-border bg-surface-2">
            {checked !== undefined ? (
              <span
                role="checkbox"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!failed) onToggleCheck?.(entry.id);
                }}
                // Keep focus where it is: focusing this row without making it
                // current would leave Space acting on a different row.
                onMouseDown={(e) => e.preventDefault()}
                aria-checked={checked}
                aria-disabled={failed || undefined}
                aria-label={t("batch.selectFile", { name: entry.name })}
                className={cn(
                  "grid h-4 w-4 place-items-center rounded border",
                  checked
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border-strong bg-background",
                  failed && "opacity-40",
                )}
              >
                {checked && <Check className="h-3 w-3" strokeWidth={2.5} />}
              </span>
            ) : (
              <Icon
                className={cn(
                  "h-4 w-4",
                  failed ? "text-destructive" : "text-foreground-subtle",
                )}
                strokeWidth={1.5}
              />
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">
              {entry.isStarred && (
                <Star
                  aria-label={t("queue.starred")}
                  className="mr-1 inline h-3 w-3 fill-current text-amber-600 dark:text-amber-400"
                />
              )}
              <QueueHighlight text={displayName} ranges={nameRanges} />
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1">
              <span
                className={cn(
                  "shrink-0 truncate font-mono text-[11px]",
                  failed ? "text-destructive" : "text-foreground-subtle",
                )}
              >
                {meta}
              </span>
              {tags.length > 0 && (
                <span
                  className="flex min-w-0 items-center gap-1"
                  title={t("queue.tags", { tags: tags.join(", ") })}
                >
                  {tags.slice(0, MAX_VISIBLE_TAGS).map((tag) => (
                    <span
                      key={tag}
                      className="min-w-0 max-w-[72px] truncate rounded bg-surface-overlay px-1 text-[10px] leading-4 text-foreground-muted"
                    >
                      {tag}
                    </span>
                  ))}
                  {tags.length > MAX_VISIBLE_TAGS && (
                    <span className="shrink-0 text-[10px] text-foreground-subtle">
                      +{tags.length - MAX_VISIBLE_TAGS}
                    </span>
                  )}
                </span>
              )}
            </span>
            {newspaper && (
              <span className="mt-0.5 block truncate text-[11px] text-foreground-subtle">
                <QueueHighlight text={newspaper} ranges={newspaperRanges} />
              </span>
            )}
          </span>
          {pageBadge && (
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground-subtle">
              {pageBadge}
            </span>
          )}
        </div>
      </div>
    );
  },
);

export const QueueItemCompact = forwardRef<HTMLDivElement, QueueItemProps>(
  function QueueItemCompact({ entry, active, tabbable, onSelect }, ref) {
    const t = useT();
    const failed = !!entry.loadError;
    const Icon = failed
      ? FileWarning
      : entry.kind === "pdf"
        ? FileText
        : FileImage;
    const tooltip = failed
      ? `${entry.name} · ${entry.loadError}`
      : entry.kind === "pdf" && (entry.pdfTotal ?? 1) > 1
        ? `${entry.name} · ${entry.currentPage ?? 1}/${entry.pdfTotal}`
        : entry.name;

    return (
      <div className="group relative" role="row" aria-selected={active}>
        <div
          ref={ref}
          role="gridcell"
          tabIndex={tabbable ? 0 : -1}
          onClick={(event) => onSelect(entry.id, event)}
          title={tooltip}
          aria-label={tooltip}
          className={cn(
            "relative grid h-10 w-full place-items-center rounded-lg transition-colors duration-100",
            CELL_FOCUS,
            active ? ACTIVE_ROW : "text-foreground-muted",
          )}
        >
          <Icon
            className={cn("h-4 w-4", failed && "text-destructive")}
            strokeWidth={1.5}
          />
          {entry.isStarred && (
            <Star
              aria-label={t("queue.starred")}
              className="absolute bottom-1 right-2 h-2.5 w-2.5 fill-current text-amber-600 dark:text-amber-400"
            />
          )}
        </div>
      </div>
    );
  },
);

/** Ranges refer to the original text, never the folded spelling. */
export function QueueHighlight({
  text,
  ranges = [],
}: {
  text: string;
  ranges?: SearchRange[];
}) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, rawEnd] of ranges) {
    const end = Math.min(text.length, rawEnd);
    if (start >= text.length || end <= cursor) continue;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark
        key={`${start}:${end}`}
        className="rounded-sm bg-amber-200/80 text-inherit dark:bg-amber-500/35"
      >
        {text.slice(Math.max(cursor, start), end)}
      </mark>,
    );
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}
