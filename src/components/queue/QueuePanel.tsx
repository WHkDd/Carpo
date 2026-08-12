import { useCallback, useRef } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileJson,
  Plus,
  Settings as SettingsIcon,
} from "lucide-react";
import { useListKeyboard } from "@/hooks/useListKeyboard";
import { isTauriRuntime } from "@/lib/runtime";
import { useStore } from "@/store";
import { useT } from "@/i18n";
import { QueueItem, QueueItemCompact } from "./QueueItem";

interface QueuePanelProps {
  /** Owned by `AppShellInner` so the drag-drop subscription and the
   *  supported-extension cache live in exactly one `useFileImport` instance. */
  onOpenFiles: () => void | Promise<void>;
  onImportPaddleJson: () => void | Promise<void>;
  onOpenSettings: () => void;
}

const ICON_BUTTON =
  "grid place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground active:bg-surface-overlay focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring";

export function QueuePanel({
  onOpenFiles,
  onImportPaddleJson,
  onOpenSettings,
}: QueuePanelProps) {
  const t = useT();
  const files = useStore((s) => s.files);
  const currentFileId = useStore((s) => s.currentFileId);
  const setCurrent = useStore((s) => s.setCurrent);
  const removeFile = useStore((s) => s.removeFile);
  const queueCollapsed = useStore((s) => s.queueCollapsed);
  const toggleQueueCollapsed = useStore((s) => s.toggleQueueCollapsed);
  const desktopRuntime = isTauriRuntime();

  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const activeIndex = files.findIndex((f) => f.id === currentFileId);

  const { onKeyDown } = useListKeyboard({
    itemCount: files.length,
    activeIndex,
    onSelect: useCallback(
      (index: number) => {
        const entry = files[index];
        if (entry) setCurrent(entry.id);
      },
      [files, setCurrent]
    ),
    labelAt: useCallback((index: number) => files[index]?.name ?? "", [files]),
    focusAt: useCallback((index: number) => rowRefs.current[index]?.focus(), []),
  });

  // Delete/Backspace on the focused row, matching Finder. Kept here rather
  // than in `useListKeyboard` because removal is queue-specific.
  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        const entry = files[activeIndex];
        if (entry) {
          e.preventDefault();
          removeFile(entry.id);
          // Focus the row that slides into this slot, or the new last row.
          const next = Math.min(activeIndex, files.length - 2);
          if (next >= 0) {
            window.requestAnimationFrame(() => rowRefs.current[next]?.focus());
          }
        }
        return;
      }
      onKeyDown(e);
    },
    [activeIndex, files, onKeyDown, removeFile]
  );

  // The list is one tab stop: whichever row is selected carries tabIndex=0
  // (the first row when nothing is selected yet, so Tab can always enter).
  const tabbableIndex = activeIndex >= 0 ? activeIndex : 0;

  if (queueCollapsed) {
    return (
      <aside className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-surface pb-2">
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden px-2 pb-2">
            <div className="mb-2 flex h-7 items-center justify-center">
              <button
                type="button"
                onClick={() => void onOpenFiles()}
                aria-label={t("queue.addFile")}
                title={t("queue.addFile")}
                className={`h-5 w-5 ${ICON_BUTTON}`}
              >
                <Plus className="h-3 w-3" strokeWidth={1.8} />
              </button>
              {desktopRuntime && (
                <button
                  type="button"
                  onClick={() => void onImportPaddleJson()}
                  aria-label={t("queue.importPaddleJson")}
                  title={t("queue.importPaddleJson")}
                  className={`h-5 w-5 ${ICON_BUTTON}`}
                >
                  <FileJson className="h-3 w-3" strokeWidth={1.8} />
                </button>
              )}
              <button
                type="button"
                onClick={toggleQueueCollapsed}
                aria-label={t("queue.expand")}
                title={t("queue.expand")}
                className={`h-5 w-5 ${ICON_BUTTON}`}
              >
                <ChevronRight className="h-3 w-3" strokeWidth={1.8} />
              </button>
            </div>

            {files.length > 0 && (
              <div className="min-h-0 overflow-y-auto overscroll-contain pb-3">
                <div
                  role="listbox"
                  aria-label={t("queue.title")}
                  aria-orientation="vertical"
                  onKeyDown={onListKeyDown}
                  className="flex flex-col items-center gap-1"
                >
                  {files.map((entry, index) => (
                    <QueueItemCompact
                      key={entry.id}
                      ref={(node) => {
                        rowRefs.current[index] = node;
                      }}
                      entry={entry}
                      active={entry.id === currentFileId}
                      tabbable={index === tabbableIndex}
                      onSelect={setCurrent}
                      onRemove={removeFile}
                    />
                  ))}
                </div>
              </div>
            )}
        </div>

        <div className="grid place-items-center border-t border-border/50 px-2 pt-1.5">
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label={t("common.settings")}
              className={`h-8 w-14 rounded-lg ${ICON_BUTTON}`}
            >
              <SettingsIcon className="h-4 w-4" strokeWidth={1.75} />
            </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-surface pb-2">
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden px-2 pb-2">
          <div className="mb-2 flex h-7 items-center justify-between gap-2 px-1.5 text-[11px] font-semibold text-foreground-subtle">
            <div className="flex min-w-0 items-center gap-2">
              <span>{t("queue.title")}</span>
              <span className="font-mono text-foreground-subtle/80">
                {files.length === 0
                  ? t("queue.empty")
                  : t("queue.count", { count: files.length })}
              </span>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => void onOpenFiles()}
                aria-label={t("queue.addFile")}
                title={t("queue.addFile")}
                className={`h-6 w-6 ${ICON_BUTTON}`}
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />
              </button>
              {desktopRuntime && (
                <button
                  type="button"
                  onClick={() => void onImportPaddleJson()}
                  aria-label={t("queue.importPaddleJson")}
                  title={t("queue.importPaddleJson")}
                  className={`h-6 w-6 ${ICON_BUTTON}`}
                >
                  <FileJson className="h-3.5 w-3.5" strokeWidth={1.8} />
                </button>
              )}
              <button
                type="button"
                onClick={toggleQueueCollapsed}
                aria-label={t("queue.collapse")}
                title={t("queue.collapse")}
                className={`h-6 w-6 ${ICON_BUTTON}`}
              >
                <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
              </button>
            </div>
          </div>

          {files.length === 0 ? (
            <button
              type="button"
              onClick={() => void onOpenFiles()}
              className="w-full rounded-md px-3 py-3 text-center text-[11px] leading-5 text-foreground-subtle transition-colors hover:bg-surface-2 hover:text-foreground-muted focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              {t("queue.dropHintLine1")}
              <br />
              {t("queue.dropHintLine2")}
            </button>
          ) : (
            <div
              role="listbox"
              aria-label={t("queue.title")}
              aria-orientation="vertical"
              onKeyDown={onListKeyDown}
              className="min-h-0 space-y-1 overflow-y-auto overscroll-contain pb-3 pr-1"
            >
              {files.map((entry, index) => (
                <QueueItem
                  key={entry.id}
                  ref={(node) => {
                    rowRefs.current[index] = node;
                  }}
                  entry={entry}
                  active={entry.id === currentFileId}
                  tabbable={index === tabbableIndex}
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
            aria-label={t("common.settings")}
            className="flex h-8 w-full translate-y-[0.5px] items-center gap-2 rounded-md px-2.5 text-[12px] text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground active:bg-surface-overlay focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <SettingsIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{t("common.settings")}</span>
          </button>
      </div>
    </aside>
  );
}
