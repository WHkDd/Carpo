import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useStore } from "@/store";
import { cancelJob as ipcCancelJob } from "@/lib/tauri";
import { appErrorMessage } from "@/lib/ipc-types";
import { cn } from "@/lib/utils";
import type { JobKind } from "@/lib/ipc-types";
import type { JobStatus } from "@/store/jobSlice";

/** Top-left canvas pill that fuses the page navigator and the OCR progress
 *  indicator into a single capsule:
 *  ┌───────┬──────────────────────────────────┐
 *  │ ⟨1/3⟩ │ 正在识别 报道1 3/10 × │
 *  └───────┴──────────────────────────────────┘
 *  ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ (progress underline, only during a run)
 *
 *  Either half is independent: the page nav slot hides on images and on
 *  single-page PDFs; the OCR slot only exists when a job is active. After a
 *  clean finish the OCR slot lingers a few seconds then auto-clears; on
 *  cancel/error it persists until the user dismisses it. */

function deriveHeadline(status: JobStatus, label: string): string {
  if (label.startsWith("准备中")) return "准备中";
  if (label.startsWith("页面已就绪")) return "已就绪";
  if (label.startsWith("识别中")) return "正在识别";
  if (label.startsWith("完成")) return "完成";

  if (status === "running") return "正在识别";
  if (status === "cancelling") return "正在取消";
  if (status === "cancelled") return "已取消";
  if (status === "error") return "出错";
  return "完成";
}

function deriveDetail(kind: JobKind, label: string): string {
  const raw = label.trim();

  if (raw.startsWith("准备中")) {
    const match = raw.match(/共\s+(\d+)\s+(篇|页)/);
    return match ? `共 ${match[1]} ${match[2]}` : "";
  }

  if (raw.startsWith("页面已就绪")) {
    if (kind === "grouped_ocr") {
      const match = raw.match(/共\s+(\d+)\s+块待识别/);
      return match ? `共 ${match[1]} 块` : "";
    }
    const match = raw.match(/共\s+(\d+)\s+页待识别/);
    return match ? `共 ${match[1]} 页` : "";
  }

  const stripped = raw.replace(/^(识别中|完成)\s*·\s*/, "").trim();

  if (kind === "grouped_ocr") {
    const articleMatch = stripped.match(/^(报道\d+)\s+第\d+\/\d+块$/);
    if (articleMatch) return articleMatch[1] ?? "";
  } else {
    const pageMatch = stripped.match(/^第(\d+)\/\d+页$/);
    if (pageMatch) return `第${pageMatch[1] ?? ""}页`;
  }

  return stripped;
}

export function ProgressPill() {
  // Page-nav slot: subscribe only to the navigation fields of the current file.
  const isPdf = useStore((s) => {
    if (!s.currentFileId) return false;
    const f = s.files.find((entry) => entry.id === s.currentFileId);
    return f?.kind === "pdf";
  });
  const totalPages = useStore((s) => {
    if (!s.currentFileId) return 1;
    return (
      s.files.find((f) => f.id === s.currentFileId)?.pdfTotal ?? 1
    );
  });
  const currentPage = useStore((s) => {
    if (!s.currentFileId) return 1;
    return (
      s.files.find((f) => f.id === s.currentFileId)?.currentPage ?? 1
    );
  });
  const prevPage = useStore((s) => s.prevPage);
  const nextPage = useStore((s) => s.nextPage);

  // OCR slot: subscribe to each primitive field separately so React only
  // re-renders on actual value changes. The progress dispatcher rebuilds the
  // `activeJob` object on every event (~1/s), but `done` / `label` etc are
  // primitives — a re-subscribe per field collapses no-op rerenders.
  const jobId = useStore((s) => s.activeJob?.jobId ?? null);
  const status = useStore((s) => s.activeJob?.status ?? null);
  const kind = useStore((s) => s.activeJob?.kind ?? null);
  const total = useStore((s) => s.activeJob?.total ?? 0);
  const done = useStore((s) => s.activeJob?.done ?? 0);
  const label = useStore((s) => s.activeJob?.label ?? "");
  const errorMessage = useStore((s) => s.activeJob?.error ?? null);
  const markCancelling = useStore((s) => s.markCancelling);
  const clearActiveJob = useStore((s) => s.clearActiveJob);

  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) setCancelError(null);
  }, [jobId]);

  useEffect(() => {
    if (status !== "done") return;
    const id = window.setTimeout(() => clearActiveJob(), 3000);
    return () => window.clearTimeout(id);
  }, [jobId, status, clearActiveJob]);

  const showPageNav = isPdf && totalPages > 1;
  const showOcr = jobId !== null;
  if (!showPageNav && !showOcr) return null;

  const inFlight = status === "running" || status === "cancelling";
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const headline = status ? deriveHeadline(status, label) : "";
  const detail = kind ? deriveDetail(kind, label) : "";

  async function onCancel() {
    if (!jobId || status !== "running") return;
    markCancelling();
    try {
      await ipcCancelJob(jobId);
    } catch (e) {
      setCancelError(appErrorMessage(e));
    }
  }

  const atFirst = currentPage <= 1;
  const atLast = currentPage >= totalPages;

  return (
    <div
      className="absolute left-2 top-2 z-10 overflow-hidden rounded-lg border border-border/60 bg-background/85 shadow-[0_2px_8px_-4px_rgba(0,0,0,0.12)] backdrop-blur-[2px]"
      role="status"
      aria-live="polite"
    >
      <div className="flex h-7 items-stretch text-[12px]">
        {showPageNav && (
          <div className="flex items-center gap-1.5 px-2">
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
              {currentPage} / {totalPages}
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
          </div>
        )}

        {showPageNav && showOcr && (
          <div className="my-1.5 w-px self-stretch bg-border/60" aria-hidden />
        )}

        {showOcr && (
          <div className="flex min-w-0 max-w-[420px] items-center gap-2 px-2">
            <span
              className={cn(
                "shrink-0 font-medium",
                status === "error"
                  ? "text-destructive"
                  : status === "cancelled" || status === "cancelling"
                    ? "text-foreground-muted"
                    : "text-foreground"
              )}
            >
              {headline}
            </span>
            {detail && (
              <span
                className="min-w-0 flex-1 truncate text-foreground-muted"
                title={label}
              >
                {detail}
              </span>
            )}
            {total > 0 && (
              <span className="shrink-0 font-mono tabular-nums text-foreground-subtle">
                {done}/{total}
              </span>
            )}
            {inFlight ? (
              <button
                type="button"
                onClick={() => void onCancel()}
                disabled={status === "cancelling"}
                aria-label={status === "cancelling" ? "正在取消" : "取消"}
                className="grid h-5 w-5 shrink-0 place-items-center rounded text-foreground-subtle transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.8} />
              </button>
            ) : (
              <button
                type="button"
                onClick={clearActiveJob}
                aria-label="关闭"
                className="grid h-5 w-5 shrink-0 place-items-center rounded text-foreground-subtle transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.8} />
              </button>
            )}
          </div>
        )}
      </div>

      {showOcr && (
        <div
          className="h-0.5 w-full overflow-hidden bg-surface-2"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total > 0 ? total : 1}
          aria-valuenow={done}
          aria-valuetext={`${done} / ${total > 0 ? total : "?"}`}
        >
          <div
            className={cn(
              "h-full transition-[width] duration-150",
              status === "error"
                ? "bg-destructive"
                : status === "cancelled"
                  ? "bg-foreground-muted/60"
                  : "bg-primary"
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {(status === "error" && errorMessage) || cancelError ? (
        <p className="px-2 pb-1 text-[10px] text-destructive" role="alert">
          {cancelError ? `取消失败：${cancelError}` : errorMessage}
        </p>
      ) : null}
    </div>
  );
}
