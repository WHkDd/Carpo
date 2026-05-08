import { useEffect, useRef } from "react";
import { ImageCanvas, type CanvasController } from "@/components/canvas/ImageCanvas";
import { QueuePanel } from "@/components/queue/QueuePanel";
import { Toolbar } from "./Toolbar";
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
  const canvasRef = useRef<CanvasController>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (!isHotkeyTarget(e.target)) return;
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
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <main className="grid h-screen min-w-[1100px] grid-cols-[244px_minmax(620px,1fr)_304px] grid-rows-[minmax(0,1fr)] overflow-hidden bg-background text-foreground">
      <QueuePanel />
      <section className="min-h-0 min-w-0 overflow-hidden p-2">
        <div className="relative h-full w-full overflow-hidden rounded-xl border border-border/60 bg-canvas">
          <ImageCanvas ref={canvasRef} />
          <Toolbar />
          <StatusBar canvasRef={canvasRef} />
        </div>
      </section>
      <StructureRail />
    </main>
  );
}
