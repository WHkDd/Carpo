import { useStore } from "@/store";
import { MousePointer2, Settings as SettingsIcon, Square } from "lucide-react";

interface ToolbarProps {
  onOpenSettings: () => void;
}

export function Toolbar({ onOpenSettings }: ToolbarProps) {
  const currentFile = useStore((s) =>
    s.currentFileId ? s.files.find((f) => f.id === s.currentFileId) ?? null : null
  );
  const manualDrawMode = useStore((s) => s.manualDrawMode);
  const toggleDrawMode = useStore((s) => s.toggleDrawMode);

  if (!currentFile) {
    // Even when there is no file, expose the settings entry — first-time
    // users land on an empty queue and still need to configure a provider.
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/80 px-3 py-1.5 shadow-sm backdrop-blur-sm">
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="设置"
          title="设置 (⌘,)"
          className="flex h-6 items-center gap-1 rounded-md px-1.5 text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
        >
          <SettingsIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span className="text-xs">设置</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-6 items-center gap-2 rounded-md border border-border/60 bg-background/80 px-2.5 shadow-sm backdrop-blur-sm">
      <h1 className="max-w-[280px] truncate text-[12px] font-semibold leading-none text-foreground">
        {currentFile.name}
      </h1>

      <div className="h-3 w-px bg-border" />

      <button
        onClick={toggleDrawMode}
        className={`flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium leading-none transition-colors ${
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
            <Square className="h-3 w-3" />
            <span>手动模式</span>
          </>
        ) : (
          <>
            <MousePointer2 className="h-3 w-3" />
            <span>浏览模式</span>
          </>
        )}
      </button>

      <div className="h-3.5 w-px bg-border" />

      <button
        type="button"
        onClick={onOpenSettings}
        aria-label="设置"
        title="设置 (⌘,)"
        className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        <SettingsIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
}
