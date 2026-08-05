import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useStore } from "@/store";
import { cancelJob as ipcCancelJob } from "@/lib/tauri";
import { appErrorMessage } from "@/lib/ipc-types";
import { cn } from "@/lib/utils";
import { useT, type Translator } from "@/i18n";
import type { ProgressStage } from "@/lib/ipc-types";
import type { JobStatus } from "@/store/jobSlice";
import { PageJumpControl } from "./PageJumpControl";

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

function deriveHeadline(
  status: JobStatus,
  stage: ProgressStage | null,
  t: Translator
): string {
  // A terminal status always wins: a late `block_done` event must not make a
  // cancelled or failed run read as "Done".
  if (status === "cancelling") return t("progress.cancelling");
  if (status === "cancelled") return t("progress.cancelled");
  if (status === "error") return t("progress.error");
  if (status === "done") return t("progress.finished");

  switch (stage?.kind) {
    case "preparing_blocks":
    case "preparing_pages":
    case "preparing_articles":
    case "preparing_chunks":
      return t("progress.preparing");
    case "page_done":
    case "block_done":
      return t("progress.finished");
    default:
      return t("progress.running");
  }
}

function deriveDetail(stage: ProgressStage | null, t: Translator): string {
  if (!stage) return "";
  switch (stage.kind) {
    case "preparing_blocks":
      return t("progress.detail.blocks", { count: stage.total });
    case "preparing_pages":
      return t("progress.detail.pages", { count: stage.total });
    case "preparing_articles":
      return t("progress.detail.articles", { count: stage.total });
    case "preparing_chunks":
      return `${t("progress.detail.chunking")} · ${t("progress.detail.pages", {
        count: stage.total,
      })}`;
    case "submitting_document":
      return `${t("progress.detail.submitting")} · ${t("progress.detail.pages", {
        count: stage.total,
      })}`;
    case "chunk_submitting":
      return `${t("progress.detail.chunk", {
        chunk: stage.chunk,
        chunks: stage.chunks,
      })} · ${t("progress.detail.pages", { count: stage.pages })}`;
    case "chunk_running":
      return t("progress.detail.chunk", {
        chunk: stage.chunk,
        chunks: stage.chunks,
      });
    case "document_running":
      return "";
    case "page_running":
    case "page_done":
      return t("progress.detail.page", { page: stage.page });
    case "block_running":
    case "block_done":
      return t("progress.detail.article", { num: stage.article_num });
  }
}

export function ProgressPill() {
  const t = useT();
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
  const fileId = useStore((s) => s.currentFileId);

  // OCR slot: subscribe to each primitive field separately so React only
  // re-renders on actual value changes. The progress dispatcher rebuilds the
  // `activeJob` object on every event (~1/s), but `done` / `label` etc are
  // primitives — a re-subscribe per field collapses no-op rerenders.
  const jobId = useStore((s) => s.activeJob?.jobId ?? null);
  const status = useStore((s) => s.activeJob?.status ?? null);
  const total = useStore((s) => s.activeJob?.total ?? 0);
  const done = useStore((s) => s.activeJob?.done ?? 0);
  const label = useStore((s) => s.activeJob?.label ?? "");
  const stage = useStore((s) => s.activeJob?.stage ?? null);
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

  const headline = status ? deriveHeadline(status, stage, t) : "";
  // Without a stage we're talking to a pre-i18n backend: show its raw label
  // rather than dropping the only progress detail we have.
  const detail = stage ? deriveDetail(stage, t) : label.trim();

  async function onCancel() {
    if (!jobId || status !== "running") return;
    markCancelling();
    try {
      await ipcCancelJob(jobId);
    } catch (e) {
      setCancelError(appErrorMessage(e));
    }
  }

  return (
    <div
      className="absolute left-2 top-2 z-10 overflow-hidden rounded-lg border border-border/60 bg-background/85 shadow-[0_2px_8px_-4px_rgba(0,0,0,0.12)] backdrop-blur-[2px]"
      role="status"
      aria-live="polite"
    >
      <div className="flex h-7 items-stretch text-[12px]">
        {showPageNav && (
          <div className="flex items-center gap-1.5 px-2">
            <PageJumpControl
              fileId={fileId}
              currentPage={currentPage}
              totalPages={totalPages}
              variant="canvas"
            />
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
                title={detail}
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
                aria-label={
                  status === "cancelling"
                    ? t("progress.cancelling")
                    : t("progress.cancel")
                }
                className="grid h-5 w-5 shrink-0 place-items-center rounded text-foreground-subtle transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.8} />
              </button>
            ) : (
              <button
                type="button"
                onClick={clearActiveJob}
                aria-label={t("common.close")}
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
          {cancelError
            ? t("progress.cancelFailed", { message: cancelError })
            : errorMessage}
        </p>
      ) : null}
    </div>
  );
}
