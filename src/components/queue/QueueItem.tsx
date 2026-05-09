import { FileText, FileImage } from "lucide-react";
import type { FileEntry } from "@/lib/ipc-types";
import { cn } from "@/lib/utils";

interface QueueItemProps {
  entry: FileEntry;
  active: boolean;
  onSelect: (id: string) => void;
}

export function QueueItem({ entry, active, onSelect }: QueueItemProps) {
  const Icon = entry.kind === "pdf" ? FileText : FileImage;
  const meta =
    entry.kind === "pdf"
      ? `pdf · ${entry.ext.toUpperCase()}`
      : `image · ${entry.ext.toUpperCase()}`;
  const pageBadge =
    entry.kind === "pdf" && (entry.pdfTotal ?? 1) > 1
      ? `${entry.currentPage ?? 1} / ${entry.pdfTotal}`
      : null;

  return (
    <button
      type="button"
      onClick={() => onSelect(entry.id)}
      className={cn(
        "relative grid w-full grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-100",
        active
          ? "bg-surface-2 text-foreground"
          : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
      )}
      aria-current={active ? "true" : undefined}
    >
      {active && (
        <span
          aria-hidden
          className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-primary"
        />
      )}
      <span className="grid h-11 w-[34px] place-items-center rounded-lg border border-border bg-[hsl(45_10%_96%)]">
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
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground-subtle">
          {pageBadge}
        </span>
      )}
    </button>
  );
}

export function QueueItemCompact({ entry, active, onSelect }: QueueItemProps) {
  const Icon = entry.kind === "pdf" ? FileText : FileImage;
  const tooltip =
    entry.kind === "pdf" && (entry.pdfTotal ?? 1) > 1
      ? `${entry.name} · ${entry.currentPage ?? 1}/${entry.pdfTotal}`
      : entry.name;

  return (
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
  );
}
