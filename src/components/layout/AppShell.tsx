import { useEffect, useRef } from "react";
import { ImageCanvas, type CanvasController } from "@/components/canvas/ImageCanvas";
import { QueuePanel } from "@/components/queue/QueuePanel";
import { PageBitmapCacheProvider } from "@/hooks/PageBitmapCacheContext";
import { usePdfPageSync } from "@/hooks/usePdfPageSync";
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

  usePdfPageSync();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isHotkeyTarget(e.target)) return;
      const meta = e.metaKey || e.ctrlKey;

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
    <main
      className="grid h-screen min-w-[1100px] grid-rows-[minmax(0,1fr)] overflow-hidden bg-background text-foreground"
      style={{
        gridTemplateColumns: `${queueCollapsed ? "76px" : "244px"} minmax(620px, 1fr) 304px`,
      }}
    >
      <QueuePanel />
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
  );
}
