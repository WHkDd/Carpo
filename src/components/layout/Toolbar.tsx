import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { useStore } from "@/store";
import { cn } from "@/lib/utils";

export function Toolbar() {
  const currentFile = useStore((s) =>
    s.currentFileId ? s.files.find((f) => f.id === s.currentFileId) ?? null : null
  );
  const prevPage = useStore((s) => s.prevPage);
  const nextPage = useStore((s) => s.nextPage);

  if (!currentFile) return null;

  const isPdf = currentFile.kind === "pdf";
  const total = currentFile.pdfTotal ?? 1;
  const page = currentFile.currentPage ?? 1;
  const showNav = isPdf && total > 1;
  const atFirst = page <= 1;
  const atLast = page >= total;

  return (
    <header className="absolute left-2 top-2 z-10 flex h-7 max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-lg border border-border/60 bg-background/75 px-2 text-[12px]">
      <FileText
        className="h-3.5 w-3.5 shrink-0 text-foreground-subtle"
        strokeWidth={1.5}
      />
      <span className="truncate font-semibold text-foreground">
        {currentFile.name}
      </span>
      {showNav && (
        <>
          <span aria-hidden className="mx-0.5 h-3 w-px bg-border/80" />
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
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
          <span className="font-mono tabular-nums text-foreground-muted">
            {page} / {total}
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
            <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
        </>
      )}
    </header>
  );
}
