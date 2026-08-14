import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useStore } from "@/store";
import { cn } from "@/lib/utils";
import { isImeCommit } from "@/lib/ime";
import { useT } from "@/i18n";

interface PageJumpControlProps {
  fileId: string | null;
  currentPage: number;
  totalPages: number;
  variant?: "canvas" | "panel";
  className?: string;
}

export function PageJumpControl({
  fileId,
  currentPage,
  totalPages,
  variant = "canvas",
  className,
}: PageJumpControlProps) {
  const t = useT();
  const setCurrentPage = useStore((s) => s.setCurrentPage);
  const [draft, setDraft] = useState(String(currentPage));
  const focusedRef = useRef(false);
  const suppressNextBlurRef = useRef(false);
  const safeTotal = Math.max(1, Math.floor(totalPages));
  const safeCurrent = clampPage(currentPage, safeTotal);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(String(safeCurrent));
    }
  }, [safeCurrent]);

  if (!fileId || safeTotal <= 1) return null;

  function commit() {
    if (!fileId) return;
    const page = clampPage(Number.parseInt(draft, 10), safeTotal, safeCurrent);
    setCurrentPage(fileId, page);
    setDraft(String(page));
    focusedRef.current = false;
  }

  function reset() {
    setDraft(String(safeCurrent));
    focusedRef.current = false;
    suppressNextBlurRef.current = true;
  }

  const atFirst = safeCurrent <= 1;
  const atLast = safeCurrent >= safeTotal;
  const inputClass =
    variant === "panel"
      ? "h-5 w-9 rounded border border-border/60 bg-surface px-1 text-center font-mono text-[11px] tabular-nums text-foreground outline-none focus:border-border-strong"
      : "h-5 w-9 rounded border border-border/60 bg-background/70 px-1 text-center font-mono text-[11px] tabular-nums text-foreground outline-none focus:border-border-strong";

  return (
    // The `/40` on the two arrows is the disabled state, and disabled
    // controls are exempt from the WCAG contrast minimum — the faintness is
    // the affordance. Every other alpha on `foreground-subtle` was removed
    // when that token was darkened to meet AA; these two stay on purpose.
    <div className={cn("flex shrink-0 items-center gap-1 whitespace-nowrap", className)}>
      <button
        type="button"
        onClick={() => setCurrentPage(fileId, safeCurrent - 1)}
        disabled={atFirst}
        aria-label={t("pageJump.prev")}
        className={cn(
          "grid h-5 w-5 place-items-center rounded transition-colors",
          atFirst
            ? "text-foreground-subtle/40"
            : "text-foreground-subtle hover:bg-surface-2 hover:text-foreground"
        )}
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
      </button>
      <label className="flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[11px] tabular-nums text-foreground-muted">
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={draft}
          aria-label={t("pageJump.input")}
          onFocus={(e) => {
            focusedRef.current = true;
            e.currentTarget.select();
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (suppressNextBlurRef.current) {
              suppressNextBlurRef.current = false;
              return;
            }
            commit();
          }}
          onKeyDown={(e) => {
            if (isImeCommit(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              reset();
              e.currentTarget.blur();
            }
          }}
          className={inputClass}
        />
        <span>/ {safeTotal}</span>
      </label>
      <button
        type="button"
        onClick={() => setCurrentPage(fileId, safeCurrent + 1)}
        disabled={atLast}
        aria-label={t("pageJump.next")}
        className={cn(
          "grid h-5 w-5 place-items-center rounded transition-colors",
          atLast
            ? "text-foreground-subtle/40"
            : "text-foreground-subtle hover:bg-surface-2 hover:text-foreground"
        )}
      >
        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.8} />
      </button>
    </div>
  );
}

function clampPage(page: number, totalPages: number, fallback = 1): number {
  const raw = Number.isFinite(page) ? page : fallback;
  return Math.min(totalPages, Math.max(1, Math.floor(raw)));
}
