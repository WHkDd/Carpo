import { FileText, FileImage, Trash2, X } from "lucide-react";
import type { FileEntry } from "@/lib/ipc-types";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

interface QueueItemProps {
  entry: FileEntry;
  active: boolean;
  onSelect: (id: string) => void;
  onRemove?: (id: string) => void;
}

export function QueueItem({ entry, active, onSelect, onRemove }: QueueItemProps) {
  const t = useT();
  const Icon = entry.kind === "pdf" ? FileText : FileImage;
  const meta = entry.ext.toUpperCase();
  const pageBadge =
    entry.kind === "pdf" && (entry.pdfTotal ?? 1) > 1
      ? `${entry.currentPage ?? 1} / ${entry.pdfTotal}`
      : null;

  return (
    <div
      className={cn(
        "group relative grid w-full grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-100",
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
      <button
        type="button"
        onClick={() => onSelect(entry.id)}
        className="contents text-left"
        aria-current={active ? "true" : undefined}
      >
        <span className="grid h-11 w-[34px] place-items-center rounded-lg border border-border bg-surface-2">
          <Icon className="h-4 w-4 text-foreground-subtle" strokeWidth={1.5} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">
            {entry.name}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-foreground-subtle">
            {meta}
          </span>
        </span>
        {pageBadge && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground-subtle transition-opacity group-hover:opacity-0">
            {pageBadge}
          </span>
        )}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(entry.id)}
          aria-label={t("queue.removeNamed", { name: entry.name })}
          title={t("queue.remove")}
          className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-foreground-subtle opacity-0 transition-colors hover:bg-background hover:text-destructive group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.7} />
        </button>
      )}
    </div>
  );
}

export function QueueItemCompact({ entry, active, onSelect, onRemove }: QueueItemProps) {
  const t = useT();
  const Icon = entry.kind === "pdf" ? FileText : FileImage;
  const tooltip =
    entry.kind === "pdf" && (entry.pdfTotal ?? 1) > 1
      ? `${entry.name} · ${entry.currentPage ?? 1}/${entry.pdfTotal}`
      : entry.name;

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onSelect(entry.id)}
        title={tooltip}
        aria-label={tooltip}
        aria-current={active ? "true" : undefined}
        className={cn(
          "relative grid h-10 w-14 place-items-center rounded-lg transition-colors duration-100",
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
        <Icon className="h-4 w-4" strokeWidth={1.5} />
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(entry.id);
          }}
          aria-label={t("queue.removeNamed", { name: entry.name })}
          className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full border border-border bg-background text-foreground-subtle opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
        >
          <X className="h-2.5 w-2.5" strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
