import { useStore } from "@/store";
import { MousePointer2, Square } from "lucide-react";

export function Toolbar() {
  const currentFile = useStore((s) =>
    s.currentFileId ? s.files.find((f) => f.id === s.currentFileId) ?? null : null
  );
  const manualDrawMode = useStore((s) => s.manualDrawMode);
  const toggleDrawMode = useStore((s) => s.toggleDrawMode);

  if (!currentFile) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/80 px-3 py-1.5 shadow-sm backdrop-blur-sm">
      <h1 className="max-w-[280px] truncate text-[13px] font-semibold text-foreground">
        {currentFile.name}
      </h1>

      <div className="h-3.5 w-px bg-border" />

      <button
        onClick={toggleDrawMode}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
          manualDrawMode
            ? "bg-primary-muted text-foreground"
            : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
        }`}
        title="手动模式"
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full transition-colors ${
            manualDrawMode ? "bg-primary" : "bg-foreground-subtle"
          }`}
        />
        {manualDrawMode ? (
          <>
            <Square className="h-3.5 w-3.5" />
            <span>手动模式</span>
          </>
        ) : (
          <>
            <MousePointer2 className="h-3.5 w-3.5" />
            <span>浏览模式</span>
          </>
        )}
      </button>
    </div>
  );
}
