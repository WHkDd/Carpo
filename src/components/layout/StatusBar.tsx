import { useEffect, useState, type RefObject } from "react";
import { Minus, Plus } from "lucide-react";
import type { CanvasController } from "@/components/canvas/ImageCanvas";
import { useStore } from "@/store";
import { clampZoomPercent } from "@/store/uiSlice";

interface StatusBarProps {
  canvasRef: RefObject<CanvasController | null>;
}

export function StatusBar({ canvasRef }: StatusBarProps) {
  const zoomPercent = useStore((s) => s.zoomPercent);
  const hasFile = useStore((s) => s.currentFileId !== null);

  const [draftZoom, setDraftZoom] = useState<string>(String(zoomPercent));

  useEffect(() => {
    setDraftZoom(String(zoomPercent));
  }, [zoomPercent]);

  const commitDraft = () => {
    const cleaned = draftZoom.replace(/[^\d]/g, "");
    if (cleaned.length === 0) {
      setDraftZoom(String(zoomPercent));
      return;
    }
    const next = clampZoomPercent(parseInt(cleaned, 10));
    canvasRef.current?.setPercent(next);
  };

  if (!hasFile) return null;

  return (
    <footer className="absolute bottom-2 left-2 z-10 flex h-7 items-center gap-1 rounded-lg border border-border/60 bg-background/75 pl-2 pr-1 text-[12px] text-foreground-muted">
      <span className="mr-1">
        OCR <strong className="font-semibold text-foreground">OpenAI</strong>
        <span className="mx-1 text-foreground-subtle">·</span>
        <span className="text-foreground">Standard</span>
      </span>
      <span className="mx-1 h-3 w-px bg-border" aria-hidden />
      <button
        type="button"
        aria-label="缩小"
        onClick={() => canvasRef.current?.zoomOut()}
        className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        <Minus className="h-3 w-3" strokeWidth={1.8} />
      </button>
      <input
        value={draftZoom}
        onChange={(e) => setDraftZoom(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraftZoom(String(zoomPercent));
            e.currentTarget.blur();
          }
        }}
        inputMode="numeric"
        aria-label="缩放百分比"
        className="h-6 w-10 rounded-md bg-transparent text-center font-mono text-[11px] font-semibold text-foreground tabular-nums outline-none transition-colors focus:bg-surface-2"
      />
      <span className="-ml-0.5 font-mono text-[10px] text-foreground-subtle">
        %
      </span>
      <button
        type="button"
        aria-label="放大"
        onClick={() => canvasRef.current?.zoomIn()}
        className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        <Plus className="h-3 w-3" strokeWidth={1.8} />
      </button>
      <button
        type="button"
        onClick={() => canvasRef.current?.fit()}
        className="ml-0.5 h-6 rounded-md px-1.5 text-[11px] font-medium text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        适应
      </button>
    </footer>
  );
}
