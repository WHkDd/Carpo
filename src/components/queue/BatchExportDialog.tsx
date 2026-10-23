import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, FileOutput, Loader2, X } from "lucide-react";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import {
  batchEntry,
  batchSummaryText,
  cancelBatchExport,
  missingUnits,
  planBatchFile,
  planOutputDocs,
  safeFileStem,
  sortBatchEntries,
  startBatchExport,
  summarizeBatch,
  type BatchEntry,
  type BatchFilePlan,
} from "@/lib/batch-export";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import type {
  BatchExportFormat,
  BatchExportItem,
  BatchExportLayout,
} from "@/store/jobSlice";
import { useT } from "@/i18n";

interface BatchExportDialogProps {
  open: boolean;
  fileIds: string[];
  onClose: () => void;
  /** The batch is running in the background; the caller leaves selection
   *  mode. */
  onStarted: () => void;
}

const LAYOUTS: BatchExportLayout[] = ["separate", "merged", "by_tag"];
const FORMATS: BatchExportFormat[] = ["docx", "md"];

/** Options sheet for a background batch. It only plans and starts — once
 *  the output destination is picked it closes, and progress moves to
 *  `BatchExportStatus` in the queue panel's footer. */
export function BatchExportDialog({
  open,
  fileIds,
  onClose,
  onStarted,
}: BatchExportDialogProps) {
  const t = useT();
  const [layout, setLayout] = useState<BatchExportLayout>("merged");
  const [format, setFormat] = useState<BatchExportFormat>("docx");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const batchRunning = useStore(
    (s) =>
      s.batchExport?.status === "running" || s.batchExport?.status === "cancelling"
  );

  // A snapshot is enough: the dialog is modal, so nothing it previews can
  // change underneath it. `startBatchExport` re-derives the same order from
  // the same store state.
  const { plans, planById, sorted } = useMemo(() => {
    if (!open) {
      return { plans: [], planById: new Map<string, PreviewPlan>(), sorted: [] };
    }
    const state = useStore.getState();
    const plans = fileIds.map((id) => planBatchFile(state, id));
    return {
      plans,
      planById: new Map(
        plans.map((p) => {
          const missing = missingUnits(state, p);
          const total = p.mode === "grouped" ? p.articles.length : p.pages.length;
          const pending =
            p.mode === "grouped" ? missing.articles.length : missing.pages.length;
          return [p.fileId, { plan: p, reused: total - pending }];
        })
      ),
      sorted: sortBatchEntries(plans.map((p) => batchEntry(state, p))),
    };
  }, [open, fileIds]);
  const docs = useMemo(() => planOutputDocs(layout, sorted), [layout, sorted]);

  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(open, dialogRef);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const result = await startBatchExport({ fileIds, layout, format });
      if (result.status === "started") onStarted();
      else if (result.status === "error") setError(result.error);
    } finally {
      setStarting(false);
    }
  };

  const runnable = plans.some((p) => !p.error);

  // Portaled: the queue panel that owns this dialog is an overflow-hidden
  // grid cell, and every other dialog mounts outside the shell's <main>.
  return createPortal(
    <div className="app-chrome fixed inset-0 z-50 flex items-center justify-center">
      <div
        role="presentation"
        className="absolute inset-0 bg-black/35 dark:bg-black/55"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-export-title"
        className="relative flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-[10px] border border-border bg-surface shadow-[0_20px_60px_-24px_rgba(0,0,0,0.22)]"
      >
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileOutput className="h-4 w-4 text-foreground-muted" strokeWidth={1.75} />
            <h2
              id="batch-export-title"
              className="truncate text-[15px] font-medium text-foreground"
            >
              {t("batch.dialogTitle")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="grid h-7 w-7 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 text-[12px] leading-relaxed">
          <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-surface-2/40 px-4 py-3">
            <OptionRow label={t("batch.layout")}>
              <Segmented
                label={t("batch.layout")}
                value={layout}
                options={LAYOUTS.map((key) => ({
                  key,
                  label: t(`batch.layout.${key}`),
                }))}
                onChange={setLayout}
              />
            </OptionRow>
            <OptionRow label={t("batch.format")}>
              <Segmented
                label={t("batch.format")}
                value={format}
                options={FORMATS.map((key) => ({
                  key,
                  label: key === "docx" ? "DOCX" : "Markdown",
                }))}
                onChange={setFormat}
              />
            </OptionRow>
          </div>

          <div className="mt-3 text-[11px] font-medium text-foreground-muted">
            {t("batch.previewTitle")}
          </div>
          <div className="mt-1.5 flex flex-col gap-2">
            {docs.map((doc, index) => (
              <section
                key={`${doc.stem}-${index}`}
                className="overflow-hidden rounded-lg border border-border/60"
              >
                {layout !== "separate" && (
                  <h3 className="truncate border-b border-border/50 bg-surface-2/60 px-3 py-1 text-[12px] font-medium text-foreground">
                    {t("batch.previewDoc", {
                      name: `${safeFileStem(doc.stem)}.${format}`,
                      count: doc.entries.length,
                    })}
                  </h3>
                )}
                <PreviewEntries entries={doc.entries} plans={planById} />
              </section>
            ))}
          </div>
          <p className="mt-2.5 text-[11px] text-foreground-subtle">{t("batch.note")}</p>
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border bg-surface-2 px-5 py-3">
          <span
            className="min-w-0 flex-1 truncate text-[11px] text-destructive"
            role={error ? "alert" : undefined}
            title={error ?? undefined}
          >
            {error ?? (batchRunning ? t("batch.alreadyRunning") : "")}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-7 rounded px-3 text-[12px] text-foreground-muted hover:bg-surface hover:text-foreground"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void start()}
              disabled={starting || batchRunning || !runnable}
              className="inline-flex h-7 items-center gap-1.5 rounded bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-opacity hover:bg-primary/90 active:bg-primary/80 disabled:cursor-default disabled:opacity-50"
            >
              {t("batch.start")}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body
  );
}

/** One output document's files, grouped by newspaper as the export will
 *  be. A missing or unparseable date is flagged in warning colour — such
 *  files sort to the end of their newspaper group. */
/** A plan plus how many of its units already have a usable result — those
 *  are reused, so only the rest cost an OCR call. */
interface PreviewPlan {
  plan: BatchFilePlan;
  reused: number;
}

function modeLabel(t: ReturnType<typeof useT>, { plan, reused }: PreviewPlan): string {
  const grouped = plan.mode === "grouped";
  const count = grouped ? plan.articles.length : plan.pages.length;
  if (reused === 0) {
    return grouped
      ? t("batch.mode.grouped", { count })
      : t("batch.mode.wholeFile", { count });
  }
  return grouped
    ? t("batch.mode.groupedReuse", { count, done: reused })
    : t("batch.mode.wholeFileReuse", { count, done: reused });
}

function PreviewEntries({
  entries,
  plans,
}: {
  entries: BatchEntry[];
  plans: Map<string, PreviewPlan>;
}) {
  const t = useT();
  const rows: React.ReactNode[] = [];
  let group: string | null = null;
  for (const entry of entries) {
    if (entry.newspaperName !== group) {
      group = entry.newspaperName;
      rows.push(
        <li
          key={`g-${entry.fileId}`}
          className="bg-surface-2/30 px-3 pt-1.5 text-[11px] font-medium text-foreground-muted"
        >
          {group || t("batch.unnamedGroup")}
        </li>
      );
    }
    const preview = plans.get(entry.fileId);
    const plan = preview?.plan;
    const dateFlag = entry.date
      ? null
      : entry.dateText
        ? t("batch.dateInvalid")
        : t("batch.dateMissing");
    rows.push(
      <li
        key={entry.fileId}
        className="flex items-center justify-between gap-3 px-3 py-1"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {entry.dateText && entry.date && (
            <span className="shrink-0 tabular-nums text-foreground-subtle">
              {entry.dateText}
            </span>
          )}
          <span className="min-w-0 truncate text-foreground" title={entry.name}>
            {entry.name}
          </span>
          {dateFlag && (
            <span
              className="shrink-0 rounded bg-warning/15 px-1 text-[10px] leading-4 text-warning"
              title={entry.dateText || undefined}
            >
              {dateFlag}
            </span>
          )}
        </span>
        <span
          className={cn(
            "shrink-0 text-[11px]",
            plan?.error ? "text-destructive" : "text-foreground-subtle"
          )}
          title={plan?.error}
        >
          {!preview || preview.plan.error
            ? t("batch.status.failed")
            : modeLabel(t, preview)}
        </span>
      </li>
    );
  }
  return <ul className="flex flex-col pb-1">{rows}</ul>;
}

function OptionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      {children}
    </div>
  );
}

function Segmented<K extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: K;
  options: Array<{ key: K; label: string }>;
  onChange: (next: K) => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 bg-surface p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map(({ key, label: optionLabel }) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(key)}
            className={`h-5 rounded px-2 text-[11px] transition-colors ${
              active
                ? "bg-primary font-medium text-primary-foreground active:bg-primary/80"
                : "text-foreground-muted hover:text-foreground active:bg-surface-overlay"
            }`}
          >
            {optionLabel}
          </button>
        );
      })}
    </div>
  );
}

function itemStatusLabel(
  t: ReturnType<typeof useT>,
  item: BatchExportItem
): string {
  if (item.status === "running" && item.total > 0) {
    return `${t("batch.status.running")} ${item.done}/${item.total}`;
  }
  return t(`batch.status.${item.status}`);
}

/** Footer row of the queue panel while a batch exists: a one-line summary
 *  that expands into the per-file list. Stays after the batch ends until
 *  dismissed, so a failure is never only a transient notification. */
export function BatchExportStatus({ compact }: { compact?: boolean }) {
  const t = useT();
  const batch = useStore((s) => s.batchExport);
  const setBatchExport = useStore((s) => s.setBatchExport);
  const toggleQueueCollapsed = useStore((s) => s.toggleQueueCollapsed);
  const [expanded, setExpanded] = useState(false);

  if (!batch) return null;
  const active = batch.status === "running" || batch.status === "cancelling";
  const finishedCount = batch.items.filter(
    (i) => i.status !== "pending" && i.status !== "running"
  ).length;
  const counts = summarizeBatch(batch.items);
  const hasProblem = counts.failed + counts.partial > 0 || !!batch.error;
  const current =
    batch.currentIndex !== null ? batch.items[batch.currentIndex] : undefined;

  const headline =
    batch.status === "cancelling"
      ? t("batch.cancelling")
      : active
        ? t("batch.progress", { done: finishedCount, total: batch.items.length })
        : batch.status === "cancelled"
          ? t("batch.cancelledTitle")
          : t("batch.finished");
  const detail = active
    ? current?.name ?? ""
    : batch.error ?? batchSummaryText(batch.items);

  if (compact) {
    return (
      <button
        type="button"
        // Expanding the queue swaps in the full row, which has the details.
        onClick={toggleQueueCollapsed}
        aria-label={`${headline} · ${detail}`}
        title={`${headline} · ${detail}`}
        className="mb-1 grid h-8 w-14 place-items-center rounded-lg text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        {active ? (
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
        ) : (
          <FileOutput
            className={cn("h-4 w-4", hasProblem && "text-destructive")}
            strokeWidth={1.75}
          />
        )}
      </button>
    );
  }

  return (
    <div className="mb-1.5 rounded-md border border-border/60 bg-surface-2/60">
      {expanded && (
        <ul
          aria-label={t("batch.details")}
          className="max-h-[40vh] overflow-y-auto border-b border-border/50 py-1"
        >
          {batch.items.map((item, index) => (
            <li
              key={`${item.fileId}-${index}`}
              className="flex items-center justify-between gap-2 px-2.5 py-1 text-[11px]"
              title={item.error}
            >
              <span className="min-w-0 truncate text-foreground-muted">{item.name}</span>
              <span
                className={cn(
                  "shrink-0 tabular-nums",
                  item.status === "failed" || item.failedUnits > 0
                    ? "text-destructive"
                    : "text-foreground-subtle"
                )}
              >
                {item.status === "done" && item.failedUnits > 0
                  ? t("batch.failedUnits", { count: item.failedUnits })
                  : itemStatusLabel(t, item)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1.5 text-left hover:bg-surface-2"
        >
          {active ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-foreground-muted" strokeWidth={1.75} />
          ) : (
            <FileOutput
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                hasProblem ? "text-destructive" : "text-foreground-muted"
              )}
              strokeWidth={1.75}
            />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] text-foreground">{headline}</span>
            {detail && (
              <span className="block truncate text-[11px] text-foreground-subtle" title={detail}>
                {detail}
              </span>
            )}
          </span>
          <ChevronDown
            className={cn(
              "h-3 w-3 shrink-0 text-foreground-subtle transition-transform",
              expanded && "rotate-180"
            )}
            strokeWidth={1.75}
          />
        </button>
        <button
          type="button"
          onClick={() => (active ? cancelBatchExport() : setBatchExport(null))}
          disabled={batch.status === "cancelling"}
          aria-label={active ? t("batch.cancel") : t("common.close")}
          title={active ? t("batch.cancel") : t("common.close")}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-foreground-subtle hover:bg-surface-2 hover:text-foreground disabled:opacity-40"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
