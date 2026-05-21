import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import { ImageCanvas, type CanvasController } from "@/components/canvas/ImageCanvas";
import { QueuePanel } from "@/components/queue/QueuePanel";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { PageBitmapCacheProvider } from "@/hooks/PageBitmapCacheContext";
import { usePdfPageSync } from "@/hooks/usePdfPageSync";
import { assembleDocument } from "@/lib/format-doc";
import { getSettings } from "@/lib/tauri";
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
      try {
        const s = await getSettings();
        if (!cancelled) setSettings(s);
      } catch (e) {
        const message = appErrorMessage(e);
        void logWarn(`settings hydrate failed: ${message}`).catch(() => {});
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
    let cancelled = false;
    (async () => {
      const subs = await Promise.all([
        listen<JobProgress>(EVENTS.JOB_PROGRESS, (e) => applyProgress(e.payload)),
        listen<JobDone>(EVENTS.JOB_DONE, (e) => {
          const job = useStore.getState().activeJob;
          // Take the assembly action only when the done payload matches the
          // current activeJob and the run wasn't cancelled. Done payloads for
          // stale or cancelled jobs are not assembled, but the slice still
          // records terminal status for the progress pill.
          if (job && job.jobId === e.payload.job_id && !e.payload.cancelled) {
            if (job.kind === "grouped_ocr") {
              const payload = e.payload as GroupedJobDone;
              // Build a per-article text map for the articles that were part
              // of *this* run. Errored articles get a sentinel so the slot
              // exists and the user sees an explicit failure marker.
              const errorById = new Map(
                payload.errors.map((er) => [er.article_id, er.message])
              );
              const resultById = new Map(
                payload.results.map((r) => [r.article_id, r.text])
              );
              const perArticle: Record<string, string> = {};
              for (const a of job.requestedArticles) {
                const text = resultById.get(a.id);
                const errMsg = errorById.get(a.id);
                perArticle[a.id] = text !== undefined
                  ? text
                  : errMsg
                    ? `[识别失败：${errMsg}]`
                    : "[未识别]";
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
              // in sync for older consumers. `source` tells us whether the
              // runner used the per-page PNG path or Paddle's document-level
              // API — propagated to `sourceMode` so the right panel and the
              // upcoming layout exporter can react accordingly.
              const payload = e.payload as WholeFileJobDone;
              const sourceMode: RecognizedPageSourceMode =
                payload.source === "paddle_document_chunk"
                  ? "paddle_document_chunk"
                  : payload.source === "paddle_document"
                  ? "paddle_document"
                  : "page_image";
              const errorByPage = new Map(
                payload.errors.map((er) => [er.page, er.message])
              );
              // Index whole entries (not just text) so the chunked
              // payload's per-row chunk_id / chunk_page survive onto
              // the stored RecognizedPage. UI never shows chunk
              // numbers — they're only there for layout export and
              // debugging.
              const resultByPage = new Map(
                payload.results.map((r) => [r.page, r])
              );
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
                        ...(row.chunk_id !== undefined
                          ? { chunkId: row.chunk_id }
                          : {}),
                        ...(row.chunk_page !== undefined
                          ? { chunkPage: row.chunk_page }
                          : {}),
                      }
                    : {
                        text:
                          errMsg !== undefined
                            ? `[识别失败：${errMsg}]`
                            : "[未识别]",
                        status: "failed",
                        error: errMsg ?? "未返回识别结果",
                        sourceMode,
                        sourceJobId: job.jobId,
                      };
              }
              setRecognizedPages(job.fileId, perPage);
            }
          }
          applyJobDone(e.payload);
        }),
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
      unlistens.forEach((u) => u());
    };
  }, [
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
