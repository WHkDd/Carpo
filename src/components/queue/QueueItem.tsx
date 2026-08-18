import { forwardRef } from "react";
import { FileText, FileImage, FileWarning, Trash2, X } from "lucide-react";
import type { FileEntry } from "@/lib/ipc-types";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

interface QueueItemProps {
  entry: FileEntry;
  active: boolean;
  /** Roving tabindex: exactly one row in the list is tabbable at a time, so
   *  the whole queue costs one Tab press to reach and is then traversed with
   *  the arrow keys — the platform's list model, not a form's. */
  tabbable: boolean;
  onSelect: (id: string) => void;
  onRemove?: (id: string) => void;
}

/** Focus styling shared by both densities and by the row commands.
 *  `focus-visible` only, so a mouse click doesn't leave a ring behind but
 *  keyboard navigation is never invisible. */
const CELL_FOCUS =
  "focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

export const QueueItem = forwardRef<HTMLDivElement, QueueItemProps>(
  function QueueItem({ entry, active, tabbable, onSelect, onRemove }, ref) {
    const t = useT();
    const failed = !!entry.loadError;
    const Icon = failed ? FileWarning : entry.kind === "pdf" ? FileText : FileImage;
    const meta = failed ? t("queue.loadFailed") : entry.ext.toUpperCase();
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
          onClick={() => onSelect(entry.id)}
          // Full reason on hover; the canvas shows it in full once selected.
          title={entry.loadError ?? undefined}
          className={cn(
            "grid w-full grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-100",
            CELL_FOCUS,
            active
              ? "bg-surface-2 text-foreground"
              : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
          )}
        >
          {active && (
            <span
              aria-hidden
              className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-primary"
            />
          )}
          <span className="grid h-11 w-[34px] place-items-center rounded-lg border border-border bg-surface-2">
            <Icon
              className={cn("h-4 w-4", failed ? "text-destructive" : "text-foreground-subtle")}
              strokeWidth={1.5}
            />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">
              {entry.name}
            </span>
            <span
              className={cn(
                "mt-0.5 block truncate font-mono text-[11px]",
                failed ? "text-destructive" : "text-foreground-subtle"
              )}
            >
              {meta}
            </span>
          </span>
          {pageBadge && (
            // Fades to make room for the hover-revealed remove button.
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground-subtle transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
              {pageBadge}
            </span>
          )}
        </div>
        {onRemove && (
          // Its own cell, outside the selection cell, so the row keeps a
          // single accessible name. Skipped by Tab and reached with → from
          // the row; Delete on the row is the shortcut for the same command.
          <div role="gridcell">
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(entry.id);
              }}
              aria-label={t("queue.removeNamed", { name: entry.name })}
              title={t("queue.remove")}
              className={`absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-foreground-subtle opacity-0 transition-colors hover:bg-background hover:text-destructive active:bg-surface-overlay group-hover:opacity-100 group-focus-within:opacity-100 ${CELL_FOCUS}`}
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.7} />
            </button>
          </div>
        )}
      </div>
    );
  }
);

export const QueueItemCompact = forwardRef<HTMLDivElement, QueueItemProps>(
  function QueueItemCompact({ entry, active, tabbable, onSelect, onRemove }, ref) {
    const t = useT();
    const failed = !!entry.loadError;
    const Icon = failed ? FileWarning : entry.kind === "pdf" ? FileText : FileImage;
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
          onClick={() => onSelect(entry.id)}
          title={tooltip}
          aria-label={tooltip}
          className={cn(
            "relative grid h-10 w-14 place-items-center rounded-lg transition-colors duration-100",
            CELL_FOCUS,
            active
              ? "bg-surface-2 text-foreground"
              : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
          )}
        >
          {active && (
            <span
              aria-hidden
              className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-primary"
            />
          )}
          <Icon
            className={cn("h-4 w-4", failed && "text-destructive")}
            strokeWidth={1.5}
          />
        </div>
        {onRemove && (
          <div role="gridcell">
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(entry.id);
              }}
              aria-label={t("queue.removeNamed", { name: entry.name })}
              className={`absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full border border-border bg-background text-foreground-subtle opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100 ${CELL_FOCUS}`}
            >
              <X className="h-2.5 w-2.5" strokeWidth={2} />
            </button>
          </div>
        )}
      </div>
    );
  }
);
