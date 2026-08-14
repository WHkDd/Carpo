import { useEffect, useMemo, useRef, useState } from "react";
import { ScanText, Square } from "lucide-react";
import { useStore } from "@/store";
import { useT } from "@/i18n";
import { isImeCommit } from "@/lib/ime";
import { useWholeFileOcrTrigger } from "@/hooks/useWholeFileOcrTrigger";
import { formatPageRangeLabel, parsePageRangePlan } from "@/lib/page-range";
import type { PageRangePlan } from "@/lib/page-range";

export function Toolbar() {
  const t = useT();
  const currentFile = useStore((s) =>
    s.currentFileId ? s.files.find((f) => f.id === s.currentFileId) ?? null : null
  );
  const recognitionMode = useStore((s) => s.recognitionMode);
  const setRecognitionMode = useStore((s) => s.setRecognitionMode);
  const manualDrawMode = useStore((s) => s.manualDrawMode);
  const toggleDrawMode = useStore((s) => s.toggleDrawMode);
  const setDrawMode = useStore((s) => s.setDrawMode);

  const { state: triggerState } = useWholeFileOcrTrigger();

  if (!currentFile) return null;

  const groupedActive = recognitionMode === "grouped";

  return (
    <div className="flex min-w-0 items-center gap-2" data-tauri-drag-region>
      <h1
        className="max-w-[360px] truncate py-0.5 text-[13px] font-semibold leading-tight text-foreground"
        data-tauri-drag-region
      >
        {currentFile.name}
      </h1>

      <div className="h-3 w-px bg-border" aria-hidden />

      {groupedActive && (
        <button
          type="button"
          onClick={toggleDrawMode}
          className={`flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium leading-none transition-colors ${
            manualDrawMode
              ? "bg-primary-muted text-foreground"
              : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
          }`}
          title={t("toolbar.toggleDraw")}
        >
          <Square className="h-3 w-3" />
          <span>{manualDrawMode ? t("toolbar.exitDraw") : t("toolbar.draw")}</span>
        </button>
      )}

      <button
        type="button"
        onClick={() => {
          if (groupedActive) {
            setRecognitionMode("whole_file");
          } else {
            setRecognitionMode("grouped");
            setDrawMode(false);
          }
        }}
        title={
          groupedActive
            ? t("toolbar.enterWholeFile")
            : t("toolbar.backToGrouped")
        }
        className={`flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium leading-none transition-colors ${
          groupedActive
            ? "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
            : "bg-primary-muted text-foreground"
        }`}
      >
        <ScanText className="h-3 w-3" />
        <span>{groupedActive ? t("toolbar.wholeFile") : t("toolbar.backToDraw")}</span>
      </button>

      {recognitionMode === "whole_file" && triggerState.showRange && (
        <>
          <div className="h-3 w-px bg-border" aria-hidden />
          <PageRangeChip
            totalPages={triggerState.totalPages}
            rangeInput={triggerState.rangeInput}
            rangePlan={triggerState.rangePlan}
            rangeError={triggerState.rangeError}
          />
        </>
      )}

      {recognitionMode === "whole_file" &&
        (triggerState.error || triggerState.rangeError) && (
        <span
          className="ml-1 max-w-[260px] truncate text-[11px] text-destructive"
          role="alert"
          title={triggerState.error ?? triggerState.rangeError ?? undefined}
        >
          {triggerState.error ?? triggerState.rangeError}
        </span>
        )}
    </div>
  );
}

function PageRangeChip({
  totalPages,
  rangeInput,
  rangePlan,
  rangeError,
}: {
  totalPages: number;
  rangeInput: string;
  rangePlan: PageRangePlan | null;
  rangeError: string | null;
}) {
  const t = useT();
  const fileId = useStore((s) => s.currentFileId);
  const setRange = useStore((s) => s.setWholeFileRange);
  const [open, setOpen] = useState(false);

  const isFull = rangeInput.trim().length === 0;
  const label = rangePlan
    ? formatPageRangeLabel(rangePlan)
    : rangeInput.trim().length > 0
      ? t("pageRange.pages", { ranges: rangeInput.trim() })
      : t("pageRange.all", { total: totalPages });

  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const [draft, setDraft] = useState(rangeInput);
  useEffect(() => {
    if (open) {
      setDraft(rangeInput);
    }
  }, [open, rangeInput]);

  const draftValidation = useMemo(() => {
    try {
      return { plan: parsePageRangePlan(draft, totalPages), error: null };
    } catch (e) {
      return {
        plan: null,
        error: e instanceof Error ? e.message : t("pageRange.invalid"),
      };
    }
  }, [draft, totalPages, t]);

  function commit() {
    if (!fileId) return;
    if (draftValidation.error) return;
    setRange(fileId, draft);
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("pageRange.chipTitle")}
        className={`flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-mono leading-none tabular-nums transition-colors ${
          isFull && rangeError === null
            ? "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
            : rangeError
              ? "bg-destructive/10 text-destructive"
              : "bg-primary-muted text-foreground"
        }`}
      >
        {label}
      </button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-30 w-[300px] rounded-md border border-border/70 bg-background p-2 shadow-lg">
          <div className="mb-2 flex items-center justify-between text-[11px] text-foreground-muted">
            <span>{t("pageRange.label")}</span>
            <span className="font-mono tabular-nums">
              {t("pageRange.total", { total: totalPages })}
            </span>
          </div>
          <div className="mb-2">
            <input
              type="text"
              value={draft}
              placeholder="1-5,8,10-12"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (isImeCommit(e)) return;
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setDraft(rangeInput);
                  setOpen(false);
                }
              }}
              className={`h-7 w-full rounded border bg-surface px-2 font-mono text-[12px] tabular-nums outline-none placeholder:text-foreground-placeholder focus:border-border-strong ${
                draftValidation.error ? "border-destructive" : "border-border/60"
              }`}
            />
            <div className="mt-1 min-h-4 text-[10px] text-foreground-subtle">
              {draftValidation.error
                ? draftValidation.error
                : draftValidation.plan
                  ? t("pageRange.summary", {
                      count: draftValidation.plan.pages.length,
                      ranges: draftValidation.plan.paddlePageRanges,
                    })
                  : t("pageRange.emptyHint")}
            </div>
          </div>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                if (fileId) setRange(fileId, null);
                setOpen(false);
              }}
              className="text-[11px] text-foreground-muted hover:text-foreground hover:underline"
            >
              {t("pageRange.resetAll")}
            </button>
            <button
              type="button"
              onClick={commit}
              className="h-6 rounded bg-primary px-2 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90"
            >
              {t("common.confirm")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
