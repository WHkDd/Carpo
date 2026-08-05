import { useEffect, useRef, useState } from "react";
import { ImageCanvas, type CanvasController } from "@/components/canvas/ImageCanvas";
import { QueuePanel } from "@/components/queue/QueuePanel";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { PageBitmapCacheProvider } from "@/hooks/PageBitmapCacheContext";
import { usePdfPageSync } from "@/hooks/usePdfPageSync";
import { assembleDocument } from "@/lib/format-doc";
import { clearPendingJob, loadPendingJob } from "@/lib/job-persistence";
import { isTauriRuntime, logWarn } from "@/lib/runtime";
import { getJobResult, getSettings, listJobs } from "@/lib/tauri";
import {
  appErrorMessage,
  EVENTS,
  type GroupedJobDone,
  type JobDone,
  type JobError,
  type JobProgress,
  type WholeFileJobDone,
} from "@/lib/ipc-types";
import { useStore } from "@/store";
import { getLanguage, t } from "@/i18n";
import { defaultOcrPrompt } from "@/store/settingsSlice";
import type { RecognizedPage, RecognizedPageSourceMode } from "@/store/jobSlice";
import { Toolbar } from "./Toolbar";
import { ProgressPill } from "./ProgressPill";
import { StatusBar } from "./StatusBar";
import { StructureRail } from "./StructureRail";

function isHotkeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  if (target.isContentEditable) return false;
  return true;
}

export function AppShell() {
  return (
    <PageBitmapCacheProvider>
      <AppShellInner />
    </PageBitmapCacheProvider>
  );
}

function AppShellInner() {
  const canvasRef = useRef<CanvasController>(null);
  const prevPage = useStore((s) => s.prevPage);
  const nextPage = useStore((s) => s.nextPage);
  const queueCollapsed = useStore((s) => s.queueCollapsed);
  const recognitionMode = useStore((s) => s.recognitionMode);
  const markSelectionAsArticle = useStore((s) => s.markSelectionAsArticle);
  const toggleDrawMode = useStore((s) => s.toggleDrawMode);
  const setSettings = useStore((s) => s.setSettings);
  const startJob = useStore((s) => s.startJob);
  const applyProgress = useStore((s) => s.applyProgress);
  const applyJobDone = useStore((s) => s.applyJobDone);
  const applyJobError = useStore((s) => s.applyJobError);
  const setDocumentResult = useStore((s) => s.setDocumentResult);
  const setArticleOcrTexts = useStore((s) => s.setArticleOcrTexts);
  const setRecognizedPages = useStore((s) => s.setRecognizedPages);
  const [settingsOpen, setSettingsOpen] = useState(false);

  usePdfPageSync();

  // Hydrate persisted settings into the slice on mount. Failures are
  // non-fatal — the slice's DEFAULT_SETTINGS keep the UI usable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Captured before `setSettings` applies the stored language: on a
      // first run this is the locale guess.
      const detected = getLanguage();
      try {
        const s = await getSettings();
        if (cancelled) return;
        if (s.language === null) {
          const isFreshDefaultPrompt = s.ocr_prompt === defaultOcrPrompt("zh");
          setSettings({
            ...s,
            language: detected,
            ...(isFreshDefaultPrompt
              ? { ocr_prompt: defaultOcrPrompt(detected) }
              : {}),
          });
          // Nothing was ever chosen (fresh install) — adopt the locale guess
          // and persist it, so the backend localizes its progress labels and
          // error messages the same way from here on.
          useStore.getState().setLanguage(detected);
        } else {
          setSettings(s);
        }
      } catch (e) {
        const message = appErrorMessage(e);
        void logWarn(`settings hydrate failed: ${message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setSettings]);

  // One global subscription for job events. The slice dispatchers filter
  // by `job_id` so stray events for unrelated jobs are no-ops.
  useEffect(() => {
    let unlistens: Array<() => void> = [];
    let eventSource: EventSource | null = null;
    let cancelled = false;
    const handleDone = (payload: JobDone) => {
      const job = useStore.getState().activeJob;
      // Take the assembly action only when the done payload matches the
      // current activeJob and the run wasn't cancelled. Done payloads for
      // stale or cancelled jobs are not assembled, but the slice still
      // records terminal status for the progress pill.
      if (job && job.jobId === payload.job_id && !payload.cancelled) {
        if (job.kind === "grouped_ocr") {
          const grouped = payload as GroupedJobDone;
          // Build a per-article text map for the articles that were part
          // of *this* run. Errored articles get a sentinel so the slot
          // exists and the user sees an explicit failure marker.
          const errorById = new Map(
            grouped.errors.map((er) => [er.article_id, er.message])
          );
          const resultById = new Map(
            grouped.results.map((r) => [r.article_id, r.text])
          );
          const perArticle: Record<string, string> = {};
          for (const a of job.requestedArticles) {
            const text = resultById.get(a.id);
            const errMsg = errorById.get(a.id);
            perArticle[a.id] = text !== undefined
              ? text
              : errMsg
                ? t("job.recognizeFailed", { message: errMsg })
                : t("job.notRecognized");
          }
          // Merge into the per-file map first, then re-assemble the full
          // document from *every* article that has text — including ones
          // OCR'd in prior partial runs. The article order follows the
          // current document state so re-ordering after OCR is honored.
          setArticleOcrTexts(job.fileId, perArticle);
          const doc = useStore.getState().getDocumentState(job.fileId);
          const merged =
            useStore.getState().articleOcrTexts[job.fileId] ?? {};
          const ordered = doc.articles
            .map((a) => ({
              id: a.id,
              title: a.title,
              text: merged[a.id] ?? "",
            }))
            .filter((a) => a.text.length > 0);
          const assembled = assembleDocument({
            newspaperName: job.newspaperName,
            newspaperDate: job.newspaperDate,
            articles: ordered,
          });
          setDocumentResult(job.fileId, assembled);
        } else {
          // whole_file: zip requestedPages with results/errors, then
          // write normalized page results while keeping legacy page text
          // in sync for older consumers.
          const whole = payload as WholeFileJobDone;
          const sourceMode: RecognizedPageSourceMode =
            whole.source === "paddle_document_chunk"
              ? "paddle_document_chunk"
              : whole.source === "paddle_document"
                ? "paddle_document"
                : "page_image";
          const errorByPage = new Map(
            whole.errors.map((er) => [er.page, er.message])
          );
          const resultByPage = new Map(whole.results.map((r) => [r.page, r]));
          const perPage: Record<number, RecognizedPage> = {};
          for (const page of job.requestedPages) {
            const row = resultByPage.get(page);
            const errMsg = errorByPage.get(page);
            perPage[page] =
              row !== undefined
                ? {
                    text: row.text,
                    status: "done",
                    sourceMode,
                    sourceJobId: job.jobId,
                    ...(row.layout !== undefined ? { layout: row.layout } : {}),
                    ...(row.chunk_id !== undefined ? { chunkId: row.chunk_id } : {}),
                    ...(row.chunk_page !== undefined
                      ? { chunkPage: row.chunk_page }
                      : {}),
                  }
                : {
                    text:
                      errMsg !== undefined
                        ? t("job.recognizeFailed", { message: errMsg })
                        : t("job.notRecognized"),
                    status: "failed",
                    error: errMsg ?? t("job.noResultReturned"),
                    sourceMode,
                    sourceJobId: job.jobId,
                  };
          }
          setRecognizedPages(job.fileId, perPage);
        }
      }
      applyJobDone(payload);
    };

    // Web/Docker only: a `broadcast`-channel SSE stream never replays past
    // events to a receiver that (re)subscribes after they fired, and a page
    // refresh wipes `activeJob` outright (it's in-memory zustand state).
    // Either way the job keeps running server-side regardless — it doesn't
    // know its browser tab went away. Reconcile against a session-persisted
    // record of the last started job so a lost `done`/`error` event can
    // still be recovered instead of leaving the UI stuck on "识别中" (or
    // silently discarding a finished result) forever. Runs once up front
    // and again on every SSE `open` (which also fires on reconnect after a
    // dropped connection, the other event-loss window).
    const reconcile = async () => {
      const pending = loadPendingJob();
      if (!pending) return;
      try {
        const running = await listJobs();
        const stillRunning = running.some((j) => j.job_id === pending.jobId);
        const alreadyTracked =
          useStore.getState().activeJob?.jobId === pending.jobId;
        if (stillRunning) {
          if (!alreadyTracked) startJob(pending);
          return;
        }
        const cached = await getJobResult(pending.jobId);
        if (!cached) {
          // Neither running nor within the server's result cache window —
          // genuinely unrecoverable (e.g. the server restarted).
          clearPendingJob();
          return;
        }
        if (!alreadyTracked) startJob(pending);
        if (cached.kind === "done") {
          handleDone(cached.payload as JobDone);
        } else if (cached.kind === "error") {
          applyJobError(cached.payload as JobError);
        }
      } catch (e) {
        void logWarn(`job reconcile failed: ${appErrorMessage(e)}`);
      }
    };

    (async () => {
      if (!isTauriRuntime()) {
        await reconcile();
        if (cancelled) return;
        const source = new EventSource("/api/jobs/events");
        eventSource = source;
        source.addEventListener("open", () => {
          void reconcile();
        });
        source.addEventListener("progress", (event) => {
          applyProgress(JSON.parse((event as MessageEvent).data) as JobProgress);
        });
        source.addEventListener("done", (event) => {
          handleDone(JSON.parse((event as MessageEvent).data) as JobDone);
        });
        source.addEventListener("error", (event) => {
          const data = (event as MessageEvent).data;
          if (typeof data === "string" && data.length > 0) {
            applyJobError(JSON.parse(data) as JobError);
          }
        });
        return;
      }
      const { listen } = await import("@tauri-apps/api/event");
      const subs = await Promise.all([
        listen<JobProgress>(EVENTS.JOB_PROGRESS, (e) => applyProgress(e.payload)),
        listen<JobDone>(EVENTS.JOB_DONE, (e) => handleDone(e.payload)),
        listen<JobError>(EVENTS.JOB_ERROR, (e) => applyJobError(e.payload)),
      ]);
      if (cancelled) {
        subs.forEach((u) => u());
      } else {
        unlistens = subs;
      }
    })();
    return () => {
      cancelled = true;
      eventSource?.close();
      unlistens.forEach((u) => u());
    };
  }, [
    startJob,
    applyProgress,
    applyJobDone,
    applyJobError,
    setDocumentResult,
    setArticleOcrTexts,
    setRecognizedPages,
  ]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      // ⌘, opens settings from anywhere, even when an input is focused.
      if (meta && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }

      if (!isHotkeyTarget(e.target)) return;

      if (meta) {
        const ctl = canvasRef.current;
        if (!ctl) return;
        if (e.key === "0") {
          e.preventDefault();
          ctl.fit();
        } else if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          ctl.zoomIn();
        } else if (e.key === "-") {
          e.preventDefault();
          ctl.zoomOut();
        } else if (e.key.toLowerCase() === "g") {
          if (recognitionMode !== "grouped") return;
          e.preventDefault();
          const fileId = useStore.getState().currentFileId;
          const file = fileId
            ? useStore.getState().files.find((f) => f.id === fileId)
            : null;
          if (fileId && file) {
            markSelectionAsArticle(fileId, file.currentPage ?? 1);
          }
        }
        return;
      }

      if (e.altKey || e.shiftKey) return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        prevPage();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nextPage();
      } else if (e.key.toLowerCase() === "v") {
        if (recognitionMode !== "grouped") return;
        e.preventDefault();
        toggleDrawMode();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [prevPage, nextPage, recognitionMode, markSelectionAsArticle, toggleDrawMode]);

  return (
    <>
      <main
        className="grid h-screen min-w-[1100px] overflow-hidden bg-background text-foreground"
        style={{
          gridTemplateColumns: `${queueCollapsed ? "76px" : "244px"} minmax(620px, 1fr) 304px`,
          gridTemplateRows: "44px minmax(0,1fr)",
        }}
      >
        {/* Row 1: title bar — traffic lights (system default) on the left,
            toolbar centered above the canvas */}
        <div className="bg-surface" data-tauri-drag-region aria-hidden />
        <div
          className="relative z-20 flex items-center justify-center bg-surface px-3"
          data-tauri-drag-region
        >
          <Toolbar />
        </div>
        <div className="bg-surface" data-tauri-drag-region aria-hidden />

        {/* Row 2: body */}
        <QueuePanel onOpenSettings={() => setSettingsOpen(true)} />
        <section className="min-h-0 min-w-0 overflow-hidden px-2 pt-2 pb-2">
          <div className="relative h-full w-full overflow-hidden rounded-xl border border-border/60 bg-canvas">
            <ImageCanvas ref={canvasRef} />
            <ProgressPill />
            <StatusBar canvasRef={canvasRef} />
          </div>
        </section>
        <StructureRail />
      </main>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  );
}
