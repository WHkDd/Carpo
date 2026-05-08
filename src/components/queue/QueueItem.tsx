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
    </button>
  );
}
