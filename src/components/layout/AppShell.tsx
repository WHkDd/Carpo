import { useCallback, useEffect, useRef, useState } from "react";
import { ImageCanvas, type CanvasController } from "@/components/canvas/ImageCanvas";
import { QueuePanel } from "@/components/queue/QueuePanel";
import {
  PaddleJsonImportDialog,
  usePaddleJsonImportFlow,
} from "@/components/queue/PaddleJsonImportDialog";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { PageBitmapCacheProvider } from "@/hooks/PageBitmapCacheContext";
import { useElementSize } from "@/hooks/useElementSize";
import { useFileImport } from "@/hooks/useFileImport";
import { useDesktopIntegration } from "@/hooks/useDesktopIntegration";
import { usePdfPageSync } from "@/hooks/usePdfPageSync";
import { isImeCommit } from "@/lib/ime";
import { assembleDocument } from "@/lib/format-doc";
import { clearPendingJob, loadPendingJob } from "@/lib/job-persistence";
import { isTauriRuntime, logWarn } from "@/lib/runtime";
import { notifyOcrResult } from "@/lib/desktop";
import { watchSystemTheme } from "@/lib/theme";
import { getJobResult, getSettings, listJobs } from "@/lib/tauri";
import {
  appErrorMessage,
  EVENTS,
  type GroupedJobDone,
  type JobDone,
  type JobError,
  type JobProgress,
  type ProofreadJobDone,
  type WholeFileJobDone,
} from "@/lib/ipc-types";
import { useStore } from "@/store";
import { getLanguage, t } from "@/i18n";
import { defaultOcrPrompt, defaultProofreadPrompt } from "@/store/settingsSlice";
import {
  CANVAS_MIN_WIDTH,
  QUEUE_COLLAPSED_WIDTH,
  QUEUE_WIDTH,
  railMaxWidth,
} from "@/store/uiSlice";
import type { RecognizedPage, RecognizedPageSourceMode } from "@/store/jobSlice";
import { buildProofreadReview, type ProofreadReview } from "@/lib/proofread";
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

function allowsNativeContextMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(
    'input, textarea, [contenteditable="true"], [data-native-context-menu]'
  ) !== null;
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
  const shellRef = useRef<HTMLElement>(null);
  const prevPage = useStore((s) => s.prevPage);
  const nextPage = useStore((s) => s.nextPage);
  const queueCollapsed = useStore((s) => s.queueCollapsed);
  const dropTargetActive = useStore((s) => s.dropTargetActive);
  const statusText = useStore((s) => s.statusText);
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
  const setProofreadReviews = useStore((s) => s.setProofreadReviews);
  const railWidth = useStore((s) => s.railWidth);
  const setRailWidth = useStore((s) => s.setRailWidth);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);

  // The rail's ceiling depends on how much room the shell has left after the
  // queue panel and the canvas floor, so it moves when the window is resized
  // or the queue is collapsed. Measure the shell rather than the viewport:
  // `min-w` means the two can differ in a browser build.
  const { width: shellWidth } = useElementSize(shellRef);
  const queueWidth = queueCollapsed ? QUEUE_COLLAPSED_WIDTH : QUEUE_WIDTH;
  const maxRailWidth = railMaxWidth(shellWidth, queueWidth);

  // Shrinking the window (or expanding the queue) can leave the rail wider
  // than the shell now allows; pull it back in rather than letting `main`'s
  // `overflow-hidden` clip the rail's right edge off-screen.
  useEffect(() => {
    if (shellWidth > 0 && railWidth > maxRailWidth) setRailWidth(maxRailWidth);
  }, [shellWidth, railWidth, maxRailWidth, setRailWidth]);

  // One `useFileImport` instance for the whole shell. The hook owns the
  // drag-drop subscription and the supported-extension cache, so mounting it
  // in more than one place would double-import every drop; the queue panel
  // now receives `openFiles` as a prop instead of calling the hook itself.
  const fileImport = useFileImport();
  const { openFiles, importPaths, pasteClipboardImage } = fileImport;
  const paddleJson = usePaddleJsonImportFlow();

  useDesktopIntegration({
    openFiles,
    importPaths,
    openPaddleJson: paddleJson.open,
    openSettings,
  });

  usePdfPageSync();

  // WebKit's generic page menu is useful only where the user can edit or copy
  // text. Canvas/chrome menus expose browser actions that do not belong in a
  // desktop utility, while OCR text keeps native Copy and Look Up.
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (!allowsNativeContextMenu(event.target)) event.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Follow OS scheme changes while the theme preference is "system". One
  // global subscription for the process; the callback no-ops for explicit
  // light/dark choices.
  useEffect(() => watchSystemTheme(), []);

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
            // Old settings.json files parse `proofread_prompt` as ""
            // (serde default); the backend falls back to the built-in at
            // call time, and the dialog must show the same text it would
            // actually send — so hydrate it here, where the language is
            // finally known.
            ...(s.proofread_prompt.trim().length === 0
              ? { proofread_prompt: defaultProofreadPrompt(detected) }
              : {}),
          });
          // Nothing was ever chosen (fresh install) — adopt the locale guess
          // and persist it, so the backend localizes its progress labels and
          // error messages the same way from here on.
          useStore.getState().setLanguage(detected);
        } else {
          setSettings({
            ...s,
            ...(s.proofread_prompt.trim().length === 0
              ? { proofread_prompt: defaultProofreadPrompt(s.language) }
              : {}),
          });
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
      if (
        job &&
        job.jobId === payload.job_id &&
        !payload.cancelled &&
        useStore.getState().files.some((file) => file.id === job.fileId)
      ) {
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
        } else if (job.kind === "whole_file") {
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
        } else if (job.kind === "proofread") {
          // proofread: zip the submitted units with results/errors and build
          // one review per unit. `baseText` comes from the submitted unit,
          // not the live store — the text may have been edited during the
          // run, and the review must diff against what the model saw. A
          // later edit then trips the stale banner instead of silently
          // mis-applying offsets.
          const proof = payload as ProofreadJobDone;
          const resultByKey = new Map(
            proof.results.map((r) => [r.key, r])
          );
          const errorByKey = new Map(
            proof.errors.map((er) => [er.key, er.message])
          );
          const reviews: Record<string, ProofreadReview> = {};
          const now = Date.now();
          for (const unit of job.units) {
            const review = buildProofreadReview(
              unit,
              resultByKey.get(unit.key),
              errorByKey.get(unit.key) ??
                (resultByKey.has(unit.key)
                  ? undefined
                  : t("job.noResultReturned")),
              now
            );
            if (review) reviews[unit.key] = review;
          }
          setProofreadReviews(job.fileId, reviews);
        }

        const fileName =
          useStore.getState().files.find((file) => file.id === job.fileId)?.name ??
          t("common.untitledFile");
        void notifyOcrResult({
          fileId: job.fileId,
          title:
            job.kind === "proofread"
              ? t("notification.proofreadDoneTitle")
              : t("notification.doneTitle"),
          body:
            job.kind === "proofread"
              ? t("notification.proofreadDoneBody", { name: fileName })
              : t("notification.doneBody", { name: fileName }),
        });
      }
      applyJobDone(payload);
    };

    const handleError = (payload: JobError) => {
      const job = useStore.getState().activeJob;
      if (
        job &&
        job.jobId === payload.job_id &&
        useStore.getState().files.some((file) => file.id === job.fileId)
      ) {
        const fileName =
          useStore.getState().files.find((file) => file.id === job.fileId)?.name ??
          t("common.untitledFile");
        void notifyOcrResult({
          fileId: job.fileId,
          title: t("notification.failedTitle"),
          body: t("notification.failedBody", { name: fileName }),
        });
      }
      applyJobError(payload);
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
          handleError(cached.payload as JobError);
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
            handleError(JSON.parse(data) as JobError);
          }
        });
        return;
      }
      const { listen } = await import("@tauri-apps/api/event");
      const subs = await Promise.all([
        listen<JobProgress>(EVENTS.JOB_PROGRESS, (e) => applyProgress(e.payload)),
        listen<JobDone>(EVENTS.JOB_DONE, (e) => handleDone(e.payload)),
        listen<JobError>(EVENTS.JOB_ERROR, (e) => handleError(e.payload)),
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
    setProofreadReviews,
  ]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Never act on a key that belongs to an IME composition, and never let
      // a held-down shortcut fire once per repeat.
      if (isImeCommit(e) || e.repeat) return;
      // A component nearer the focus already claimed this key. Notably the
      // queue and article lists use ←/→ to reach a row's commands, and this
      // handler binds the same keys to page turns.
      if (e.defaultPrevented) return;

      const meta = e.metaKey || e.ctrlKey;

      // macOS receives Cmd+O through the native File menu. Other desktop
      // platforms use Ctrl+O here; browser builds keep the platform-native
      // modifier because they do not have a Tauri menu.
      if (
        meta &&
        e.key.toLowerCase() === "o" &&
        (!isTauriRuntime() || !e.metaKey)
      ) {
        e.preventDefault();
        void openFiles();
        return;
      }

      // ⌘, opens settings from anywhere, even when an input is focused.
      if (meta && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }

      if (!isHotkeyTarget(e.target)) return;

      // ⌘V / Ctrl+V imports a screenshot — but only outside a text field.
      // `isHotkeyTarget` above already excluded inputs, textareas, selects and
      // contentEditable, so ordinary text pasting is untouched. Handled ahead
      // of the zoom shortcuts so "v" never reaches the draw-mode toggle.
      if (meta && e.key.toLowerCase() === "v") {
        if (e.shiftKey || e.altKey) return;
        e.preventDefault();
        void pasteClipboardImage();
        return;
      }

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
  }, [
    prevPage,
    nextPage,
    recognitionMode,
    markSelectionAsArticle,
    toggleDrawMode,
    openFiles,
    pasteClipboardImage,
  ]);

  return (
    <>
      {/* min-w 1180 = 244 (queue) + 552 (canvas) + 384 (rail) + borders, and
          matches `minWidth` in tauri.conf.json. The old 1100 sat below the
          three-column floor, so the right rail got clipped at the smallest
          window size the OS would allow. The canvas column's own floor is
          lower (CANVAS_MIN_WIDTH) — it is what the rail may eat into when
          dragged wider, and never binds at the default rail width. */}
      <main
        ref={shellRef}
        className="app-chrome grid h-screen min-w-[1180px] overflow-hidden bg-background text-foreground"
        style={{
          gridTemplateColumns: `${queueWidth}px minmax(${CANVAS_MIN_WIDTH}px, 1fr) ${railWidth}px`,
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
        <QueuePanel
          onOpenFiles={openFiles}
          onImportPaddleJson={paddleJson.open}
          onOpenSettings={openSettings}
        />
        <section className="min-h-0 min-w-0 overflow-hidden px-2 pt-2 pb-2">
          <div className="relative h-full w-full overflow-hidden rounded-xl border border-border/60 bg-canvas">
            <ImageCanvas ref={canvasRef} />
            {dropTargetActive && (
              <div
                className="pointer-events-none absolute inset-0 z-40 grid place-items-center border-2 border-primary/70 bg-background/75"
                role="status"
                aria-live="polite"
              >
                <span className="rounded-md border border-border bg-background px-3 py-2 text-[13px] font-medium text-foreground shadow-sm">
                  {t("canvas.dropTarget")}
                </span>
              </div>
            )}
            <ProgressPill />
            <StatusBar canvasRef={canvasRef} />
            {statusText !== t("common.ready") && !dropTargetActive && (
              <div
                className="pointer-events-none absolute bottom-[2.5px] right-2 z-20 max-w-[55%] truncate rounded-lg border border-border/60 bg-background/85 px-2.5 py-1.5 text-[11px] text-foreground-muted"
                role="status"
                aria-live="polite"
                title={statusText}
              >
                {statusText}
              </div>
            )}
          </div>
        </section>
        <StructureRail maxWidth={maxRailWidth} />
      </main>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      {isTauriRuntime() && (
        <PaddleJsonImportDialog
          open={paddleJson.path !== null}
          path={paddleJson.path}
          onClose={paddleJson.close}
        />
      )}
    </>
  );
}
