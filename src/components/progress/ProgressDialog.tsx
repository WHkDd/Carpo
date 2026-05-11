import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useStore } from "@/store";
import { cancelJob as ipcCancelJob } from "@/lib/tauri";

/** Non-closable modal that surfaces grouped-OCR job progress and lets the
 *  user cancel mid-flight. The job state lives in `jobSlice`; the dialog is
 *  pure presentation + the cancel side-effect.
 *
 *  T5.6: events are subscribed in `AppShell` (single global listener); this
 *  component renders whatever `activeJob` reports. Once T5.7 lands, the
 *  terminal-state "完成" path will hand `activeJob.result` to the result
 *  drawer before clearing.
 */
export function ProgressDialog() {
  const activeJob = useStore((s) => s.activeJob);
  const markCancelling = useStore((s) => s.markCancelling);
  const clearActiveJob = useStore((s) => s.clearActiveJob);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Reset transient cancel error whenever a new job starts.
  useEffect(() => {
    if (!activeJob) setCancelError(null);
  }, [activeJob?.jobId]);

  if (!activeJob) return null;

  const { status, done, total, label, error } = activeJob;
  const inFlight = status === "running" || status === "cancelling";
  const pct =
    total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const headline =
    status === "running"
      ? "正在识别"
      : status === "cancelling"
        ? "正在取消…"
        : status === "cancelled"
          ? "已取消"
          : status === "error"
            ? "出错"
            : "完成";

  async function onCancel() {
    if (!activeJob || activeJob.status !== "running") return;
    markCancelling();
    try {
      await ipcCancelJob(activeJob.jobId);
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="progress-title"
    >
      {/* Backdrop is non-interactive while in flight — clicking through would
          imply dismissal, but the job is still running. Only after the job
          settles does the close button appear. */}
      <div className="absolute inset-0 bg-foreground/25" aria-hidden />

      <div className="relative flex w-full max-w-md flex-col gap-4 rounded-[10px] border border-border bg-surface px-6 py-5 shadow-[0_20px_60px_-24px_rgba(0,0,0,0.22)]">
        <header className="flex items-center justify-between">
          <h2
            id="progress-title"
            className="text-[15px] font-medium text-foreground"
          >
            {headline}
          </h2>
          {!inFlight && (
            <button
              type="button"
              onClick={clearActiveJob}
              aria-label="关闭"
              className="grid h-7 w-7 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </button>
          )}
        </header>

        <div className="space-y-2">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total > 0 ? total : 1}
            aria-valuenow={done}
            aria-valuetext={`${done} / ${total > 0 ? total : "?"}`}
          >
            <div
              className={`h-full rounded-full transition-[width] duration-150 ${
                status === "error"
                  ? "bg-destructive"
                  : status === "cancelled"
                    ? "bg-foreground-muted"
                    : "bg-primary"
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-baseline justify-between gap-3 text-[12px]">
            <span className="truncate text-foreground-muted" title={label}>
              {label}
            </span>
            <span className="font-mono tabular-nums text-foreground-subtle">
              {total > 0 ? `${done} / ${total}` : "—"}
            </span>
          </div>
        </div>

        {status === "error" && error && (
          <p className="rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
            {error}
          </p>
        )}

        {cancelError && (
          <p className="text-[11px] text-destructive">
            取消失败：{cancelError}
          </p>
        )}

        <footer className="flex items-center justify-end gap-2">
          {inFlight ? (
            <button
              type="button"
              onClick={() => void onCancel()}
              disabled={status === "cancelling"}
              className="flex h-8 items-center rounded border border-border bg-transparent px-3 text-[13px] text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              {status === "cancelling" ? "取消中…" : "取消"}
            </button>
          ) : (
            <button
              type="button"
              onClick={clearActiveJob}
              className="flex h-8 items-center rounded bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              关闭
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
