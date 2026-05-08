import { Plus } from "lucide-react";
import { useFileImport } from "@/hooks/useFileImport";
import { useStore } from "@/store";
import { QueueItem } from "./QueueItem";

export function QueuePanel() {
  const files = useStore((s) => s.files);
  const currentFileId = useStore((s) => s.currentFileId);
  const setCurrent = useStore((s) => s.setCurrent);
  const { openFiles } = useFileImport();

  return (
    <aside className="grid min-h-0 grid-rows-[48px_minmax(0,1fr)] bg-surface">
      <div className="flex items-center px-3.5">
        <div className="flex gap-2" aria-hidden>
          <span className="h-3 w-3 rounded-full border border-black/10 bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full border border-black/10 bg-[#ffbd2e]" />
          <span className="h-3 w-3 rounded-full border border-black/10 bg-[#28c840]" />
        </div>
      </div>

      <div className="min-h-0 overflow-hidden p-2">
        <div className="mb-2 flex h-7 items-center justify-between gap-2 px-1.5 text-[11px] font-semibold text-foreground-subtle">
          <div className="flex min-w-0 items-center gap-2">
            <span>扫描队列</span>
            <span className="font-mono text-foreground-subtle/80">
              {files.length === 0 ? "空" : `${files.length} 项`}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void openFiles()}
            aria-label="添加文件"
            className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
        </div>

        {files.length === 0 ? (
          <button
            type="button"
            onClick={() => void openFiles()}
            className="mt-10 w-full rounded-md px-3 py-3 text-center text-[11px] leading-5 text-foreground-subtle transition-colors hover:bg-surface-2 hover:text-foreground-muted"
          >
            将扫描件拖入窗口
            <br />
            或点此添加文件
          </button>
        ) : (
          <div className="space-y-1 overflow-y-auto pb-3">
            {files.map((entry) => (
              <QueueItem
                key={entry.id}
                entry={entry}
                active={entry.id === currentFileId}
                onSelect={setCurrent}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
