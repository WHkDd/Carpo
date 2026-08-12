import { useCallback, useRef } from "react";
import { useStore } from "@/store";
import { useT } from "@/i18n";
import { OCR_PANEL_MAX_RESERVE, OCR_PANEL_MIN_HEIGHT } from "@/store/uiSlice";
import { MetadataInline } from "@/components/structure/MetadataInline";
import { BlockOpsPanel } from "@/components/structure/BlockOpsPanel";
import { ArticleList } from "@/components/structure/ArticleList";
import {
  OcrBulkActions,
  OcrTextPanel,
} from "@/components/structure/OcrTextPanel";
import { useGroupedOcrTrigger } from "@/hooks/useGroupedOcrTrigger";
import { useWholeFileOcrTrigger } from "@/hooks/useWholeFileOcrTrigger";

export function StructureRail() {
  const recognitionMode = useStore((s) => s.recognitionMode);

  return recognitionMode === "grouped" ? (
    <GroupedRail />
  ) : (
    <WholeFileRail />
  );
}

function GroupedRail() {
  const t = useT();
  const ocrPanelHeight = useStore((s) => s.ocrPanelHeight);
  const setOcrPanelHeight = useStore((s) => s.setOcrPanelHeight);
  const asideRef = useRef<HTMLElement>(null);
  const fileId = useStore((s) => s.currentFileId) ?? "";
  const hasFile = fileId !== "";
  const activeJobRunning = useStore(
    (s) =>
      s.activeJob !== null &&
      (s.activeJob.status === "running" || s.activeJob.status === "cancelling")
  );

  const { state, trigger } = useGroupedOcrTrigger();
  const canTrigger =
    hasFile && state.ready && !state.starting && !activeJobRunning;

  const onDividerDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = useStore.getState().ocrPanelHeight;
      const railH = asideRef.current?.getBoundingClientRect().height ?? 800;
      const maxH = Math.max(
        OCR_PANEL_MIN_HEIGHT,
        railH - OCR_PANEL_MAX_RESERVE
      );
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        const deltaY = ev.clientY - startY;
        const next = Math.min(
          maxH,
          Math.max(OCR_PANEL_MIN_HEIGHT, startHeight - deltaY)
        );
        setOcrPanelHeight(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [setOcrPanelHeight]
  );

  const maxPanelHeight = Math.max(
    OCR_PANEL_MIN_HEIGHT,
    (asideRef.current?.getBoundingClientRect().height ?? 800) -
      OCR_PANEL_MAX_RESERVE
  );

  // A separator that can only be dragged is a mouse-only control. Arrow keys
  // resize by one step, ⇧+arrow by a coarse step, Home/End jump to the bounds
  // — the same model as a native split view divider.
  const onDividerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const railH = asideRef.current?.getBoundingClientRect().height ?? 800;
      const maxH = Math.max(OCR_PANEL_MIN_HEIGHT, railH - OCR_PANEL_MAX_RESERVE);
      const step = e.shiftKey ? 48 : 12;
      const current = useStore.getState().ocrPanelHeight;
      let next: number | null = null;
      // Up grows the panel below the divider, which is what moving the
      // divider up actually does.
      if (e.key === "ArrowUp") next = current + step;
      else if (e.key === "ArrowDown") next = current - step;
      else if (e.key === "Home") next = OCR_PANEL_MIN_HEIGHT;
      else if (e.key === "End") next = maxH;
      if (next === null) return;
      e.preventDefault();
      setOcrPanelHeight(Math.min(maxH, Math.max(OCR_PANEL_MIN_HEIGHT, next)));
    },
    [setOcrPanelHeight]
  );

  const triggerLabel = state.starting
    ? t("rail.starting")
    : state.selectedCount > 0
      ? t("rail.recognizeSelectedCount", { count: state.selectedCount })
      : t("rail.recognizeSelected");

  return (
    <aside ref={asideRef} className="flex min-h-0 flex-col bg-surface">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pt-px pb-2">
        <div className="mb-2 flex h-7 items-center justify-between gap-2 px-1.5">
          <span className="text-[13px] font-semibold text-foreground">
            {t("rail.groupedTitle")}
          </span>
          <OcrBulkActions />
        </div>

        {hasFile ? (
          <div className="flex flex-col gap-3 overflow-y-auto overscroll-contain px-1.5 pb-2">
            <MetadataInline />
            <BlockOpsPanel />
            <div className="border-t border-border/40" />
            <ArticleList />
          </div>
        ) : (
          <p className="px-1.5 pt-3 text-[12px] leading-5 text-foreground-subtle">
            {t("rail.groupedEmpty")}
          </p>
        )}
      </div>

      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("rail.resizeOcrPanel")}
        aria-valuemin={OCR_PANEL_MIN_HEIGHT}
        aria-valuemax={maxPanelHeight}
        aria-valuenow={ocrPanelHeight}
        tabIndex={0}
        onPointerDown={onDividerDrag}
        onKeyDown={onDividerKeyDown}
        className="group relative h-1.5 shrink-0 cursor-row-resize focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border/60 transition-colors group-hover:bg-border-strong" />
      </div>

      <div
        className="flex shrink-0 flex-col overflow-hidden"
        style={{ height: `${ocrPanelHeight}px` }}
      >
        <OcrTextPanel />
      </div>

      <div className="flex shrink-0 flex-col gap-1 px-3 pt-1.5 pb-2">
        {state.error && (
          <p
            className="text-[11px] leading-tight text-destructive"
            role="alert"
          >
            {state.error}
          </p>
        )}
        <div className="flex items-center justify-end">
          <button
            type="button"
            disabled={!canTrigger}
            onClick={() => void trigger()}
            className="h-8 rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground transition-opacity hover:bg-primary/90 disabled:cursor-default disabled:opacity-50"
          >
            {triggerLabel}
          </button>
        </div>
      </div>
    </aside>
  );
}

function WholeFileRail() {
  const t = useT();
  const fileId = useStore((s) => s.currentFileId) ?? "";
  const file = useStore((s) =>
    fileId ? s.files.find((f) => f.id === fileId) ?? null : null
  );
  const activeJobRunning = useStore(
    (s) =>
      s.activeJob !== null &&
      (s.activeJob.status === "running" || s.activeJob.status === "cancelling")
  );

  const { state, trigger } = useWholeFileOcrTrigger();
  const canTrigger =
    !!file && state.ready && !state.starting && !activeJobRunning;
  const triggerLabel = state.starting
    ? t("rail.starting")
    : state.pageCount > 0
      ? t("rail.startWholeFileCount", { count: state.pageCount })
      : t("rail.startWholeFile");

  return (
    <aside className="flex min-h-0 flex-col bg-surface">
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-3">
        <span className="text-[13px] font-semibold text-foreground">
          {t("rail.wholeFileTitle")}
        </span>
        <OcrBulkActions />
      </div>

      {file && (
        <div className="shrink-0 px-3 pb-2">
          <MetadataInline />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        <OcrTextPanel />
      </div>

      <div className="flex shrink-0 flex-col gap-1 px-3 pt-1.5 pb-2">
        {state.error && (
          <p
            className="text-[11px] leading-tight text-destructive"
            role="alert"
          >
            {state.error}
          </p>
        )}
        <div className="flex items-center justify-end">
          <button
            type="button"
            disabled={!canTrigger}
            onClick={() => void trigger()}
            className="h-8 rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground transition-opacity hover:bg-primary/90 disabled:cursor-default disabled:opacity-50"
          >
            {triggerLabel}
          </button>
        </div>
      </div>
    </aside>
  );
}
