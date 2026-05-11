import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ImageCanvas, type CanvasController } from "@/components/canvas/ImageCanvas";
import { ProgressDialog } from "@/components/progress/ProgressDialog";
import { QueuePanel } from "@/components/queue/QueuePanel";
import { ResultDrawer } from "@/components/results/ResultDrawer";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { PageBitmapCacheProvider } from "@/hooks/PageBitmapCacheContext";
import { usePdfPageSync } from "@/hooks/usePdfPageSync";
import { assembleDocument } from "@/lib/format-doc";
import { getSettings } from "@/lib/tauri";
import { EVENTS, type JobDone, type JobError, type JobProgress } from "@/lib/ipc-types";
import { useStore } from "@/store";
import { Toolbar } from "./Toolbar";
import { PageNavigator } from "./PageNavigator";
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
  const markSelectionAsArticle = useStore((s) => s.markSelectionAsArticle);
  const toggleDrawMode = useStore((s) => s.toggleDrawMode);
  const setSettings = useStore((s) => s.setSettings);
  const applyProgress = useStore((s) => s.applyProgress);
  const applyJobDone = useStore((s) => s.applyJobDone);
  const applyJobError = useStore((s) => s.applyJobError);
  const setDocumentResult = useStore((s) => s.setDocumentResult);
  const openResultDrawer = useStore((s) => s.openResultDrawer);
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
        console.warn("settings hydrate failed", e);
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
          // stale or cancelled jobs are not assembled into a document, but
          // the slice still records terminal status for the ProgressDialog.
          if (
            job &&
            job.jobId === e.payload.job_id &&
            !e.payload.cancelled
          ) {
            // Zip article snapshot (id → title) with backend results, then
            // assemble. Articles that errored have no result row; we surface
            // their failure in the document body as a marker so the file
            // isn't silently incomplete.
            const titleById = new Map(
              job.requestedArticles.map((a) => [a.id, a.title])
            );
            const errorById = new Map(
              e.payload.errors.map((er) => [er.article_id, er.message])
            );
            const ordered = job.requestedArticles.map((a) => {
              const row = e.payload.results.find(
                (r) => r.article_id === a.id
              );
              if (row) {
                return { title: titleById.get(a.id) ?? "", text: row.text };
              }
              const errMsg = errorById.get(a.id) ?? "未识别";
              return {
                title: titleById.get(a.id) ?? "",
                text: `[识别失败：${errMsg}]`,
              };
            });
            const doc = assembleDocument({
              newspaperName: job.newspaperName,
              newspaperDate: job.newspaperDate,
              articles: ordered,
            });
            setDocumentResult(job.fileId, doc);
            openResultDrawer();
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
    openResultDrawer,
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
        e.preventDefault();
        toggleDrawMode();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [prevPage, nextPage, markSelectionAsArticle, toggleDrawMode]);

  return (
    <>
      <main
        className="grid h-screen min-w-[1100px] grid-rows-[minmax(0,1fr)] overflow-hidden bg-background text-foreground"
        style={{
          gridTemplateColumns: `${queueCollapsed ? "76px" : "244px"} minmax(620px, 1fr) 304px`,
        }}
      >
        <QueuePanel onOpenSettings={() => setSettingsOpen(true)} />
        <section className="grid min-h-0 min-w-0 grid-rows-[28px_minmax(0,1fr)] overflow-hidden">
          <div className="flex items-center justify-center px-3">
            <Toolbar />
          </div>
          <div className="min-h-0 overflow-hidden p-2">
            <div className="relative h-full w-full overflow-hidden rounded-xl border border-border/60 bg-canvas">
              <ImageCanvas ref={canvasRef} />
              <PageNavigator />
              <StatusBar canvasRef={canvasRef} />
            </div>
          </div>
        </section>
        <StructureRail />
      </main>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <ProgressDialog />
      <ResultDrawer />
    </>
  );
}
