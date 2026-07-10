import {
  ChevronLeft,
  ChevronRight,
  FileJson,
  Plus,
  Settings as SettingsIcon,
} from "lucide-react";
import { useFileImport } from "@/hooks/useFileImport";
import { isTauriRuntime } from "@/lib/runtime";
import { useStore } from "@/store";
import {
  PaddleJsonImportDialog,
  usePaddleJsonImportFlow,
} from "./PaddleJsonImportDialog";
import { QueueItem, QueueItemCompact } from "./QueueItem";

interface QueuePanelProps {
  onOpenSettings: () => void;
}

export function QueuePanel({ onOpenSettings }: QueuePanelProps) {
  const files = useStore((s) => s.files);
  const currentFileId = useStore((s) => s.currentFileId);
  const setCurrent = useStore((s) => s.setCurrent);
  const removeFile = useStore((s) => s.removeFile);
  const queueCollapsed = useStore((s) => s.queueCollapsed);
  const toggleQueueCollapsed = useStore((s) => s.toggleQueueCollapsed);
  const { openFiles } = useFileImport();
  const paddleJson = usePaddleJsonImportFlow();
  const desktopRuntime = isTauriRuntime();

  if (queueCollapsed) {
    return (
      <>
        <aside className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] bg-surface pb-2">
          <div className="min-h-0 overflow-hidden px-2 pb-2">
            <div className="mb-2 flex h-7 items-center justify-center">
              <button
                type="button"
                onClick={() => void openFiles()}
                aria-label="添加文件"
                title="添加文件"
                className="grid h-5 w-5 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <Plus className="h-3 w-3" strokeWidth={1.8} />
              </button>
              {desktopRuntime && (
                <button
                  type="button"
                  onClick={() => void paddleJson.open()}
                  aria-label="导入 Paddle JSON"
                  title="导入 Paddle JSON"
                  className="grid h-5 w-5 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                >
                  <FileJson className="h-3 w-3" strokeWidth={1.8} />
                </button>
              )}
              <button
                type="button"
                onClick={toggleQueueCollapsed}
                aria-label="展开队列"
                title="展开队列"
                className="grid h-5 w-5 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <ChevronRight className="h-3 w-3" strokeWidth={1.8} />
              </button>
            </div>

            {files.length > 0 && (
              <div className="flex flex-col items-center gap-1 overflow-y-auto pb-3">
                {files.map((entry) => (
                  <QueueItemCompact
                    key={entry.id}
                    entry={entry}
                    active={entry.id === currentFileId}
                    onSelect={setCurrent}
                    onRemove={removeFile}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="grid place-items-center border-t border-border/50 px-2 pt-1.5">
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label="设置"
              className="grid h-8 w-14 place-items-center rounded-lg text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <SettingsIcon className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        </aside>
        {desktopRuntime && (
          <PaddleJsonImportDialog
            open={paddleJson.path !== null}
            path={paddleJson.path}
            onClose={paddleJson.close}
          />
        )}
      </>
    );
  }

  return (
    <>
      <aside className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] bg-surface pb-2">
        <div className="min-h-0 overflow-hidden px-2 pb-2">
          <div className="mb-2 flex h-7 items-center justify-between gap-2 px-1.5 text-[11px] font-semibold text-foreground-subtle">
            <div className="flex min-w-0 items-center gap-2">
              <span>扫描队列</span>
              <span className="font-mono text-foreground-subtle/80">
                {files.length === 0 ? "空" : `${files.length} 项`}
              </span>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => void openFiles()}
                aria-label="添加文件"
                title="添加文件"
                className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />
              </button>
              {desktopRuntime && (
                <button
                  type="button"
                  onClick={() => void paddleJson.open()}
                  aria-label="导入 Paddle JSON"
                  title="导入 Paddle JSON"
                  className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                >
                  <FileJson className="h-3.5 w-3.5" strokeWidth={1.8} />
                </button>
              )}
              <button
                type="button"
                onClick={toggleQueueCollapsed}
                aria-label="收起队列"
                title="收起队列"
                className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
              </button>
            </div>
          </div>

          {files.length === 0 ? (
            <button
              type="button"
              onClick={() => void openFiles()}
              className="w-full rounded-md px-3 py-3 text-center text-[11px] leading-5 text-foreground-subtle transition-colors hover:bg-surface-2 hover:text-foreground-muted"
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
                  onRemove={removeFile}
                />
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-border/50 px-1.5 pt-1.5">
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="设置"
            className="flex h-8 w-full translate-y-[0.5px] items-center gap-2 rounded-md px-2.5 text-[12px] text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <SettingsIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>设置</span>
          </button>
        </div>
      </aside>
      {desktopRuntime && (
        <PaddleJsonImportDialog
          open={paddleJson.path !== null}
          path={paddleJson.path}
          onClose={paddleJson.close}
        />
      )}
    </>
  );
}
