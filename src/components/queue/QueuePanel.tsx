import { useCallback, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileJson,
  FileOutput,
  Plus,
  Settings as SettingsIcon,
  Tags,
} from "lucide-react";
import { DropMenu } from "@/components/ui/DropMenu";
import { useListKeyboard } from "@/hooks/useListKeyboard";
import { isImeCommit } from "@/lib/ime";
import { isTauriRuntime } from "@/lib/runtime";
import { useStore } from "@/store";
import { useT } from "@/i18n";
import { QueueItem, QueueItemCompact } from "./QueueItem";
import { BatchExportDialog, BatchExportStatus } from "./BatchExportDialog";

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

  // Batch-export selection mode. Local state: nothing outside this panel
  // needs to know which rows are ticked until the batch actually starts.
  const [selecting, setSelecting] = useState(false);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const selectableIds = useMemo(
    () => files.filter((f) => !f.loadError).map((f) => f.id),
    [files]
  );
  // Queue order, and only files still in the queue.
  const batchFileIds = useMemo(
    () => selectableIds.filter((id) => checkedIds.includes(id)),
    [selectableIds, checkedIds]
  );
  const allChecked =
    selectableIds.length > 0 && batchFileIds.length === selectableIds.length;
  const toggleChecked = useCallback(
    (id: string) => {
      if (!selectableIds.includes(id)) return;
      setCheckedIds((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      );
    },
    [selectableIds]
  );
  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setCheckedIds([]);
    setBatchDialogOpen(false);
    setMetaEditor(null);
  }, []);
  const closeBatchDialog = useCallback(() => setBatchDialogOpen(false), []);
  const [metaEditor, setMetaEditor] = useState<MetaAction | null>(null);

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
      if (selecting) {
        // The ticked rows and the current row are different sets here, so
        // Delete would remove a file the user may not be looking at. Space
        // ticks the current row instead.
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          return;
        }
        if (e.key === " ") {
          e.preventDefault();
          const entry = files[activeIndex];
          if (entry) toggleChecked(entry.id);
          return;
        }
      }
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
    [activeIndex, files, onKeyDown, removeFile, selecting, toggleChecked]
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
                  role="grid"
                  aria-label={t("queue.title")}
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
            <BatchExportStatus compact />
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
      <div className="flex min-h-0 flex-col overflow-hidden px-2 pb-2">
          <div className="mb-2 flex h-7 shrink-0 items-center justify-between gap-2 px-1.5 text-[11px] font-semibold text-foreground-subtle">
            <div className="flex min-w-0 items-center gap-2">
              <span>{t("queue.title")}</span>
              <span className="font-mono text-foreground-subtle">
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
                onClick={() => (selecting ? exitSelecting() : setSelecting(true))}
                disabled={files.length === 0}
                aria-pressed={selecting}
                aria-label={t("batch.button")}
                title={t("batch.button")}
                className={`h-6 w-6 disabled:opacity-40 ${ICON_BUTTON} ${
                  selecting ? "bg-surface-2 text-foreground" : ""
                }`}
              >
                <FileOutput className="h-3.5 w-3.5" strokeWidth={1.8} />
              </button>
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

          {selecting && files.length > 0 && (
            <div className="mb-1.5 flex shrink-0 items-center gap-1.5 rounded-md bg-surface-2/60 px-1.5 py-1 text-[11px]">
              <label className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 text-foreground-muted">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() => setCheckedIds(allChecked ? [] : selectableIds)}
                  aria-label={t("batch.selectAll")}
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                />
                <span className="truncate">
                  {batchFileIds.length > 0
                    ? t("batch.selectedCount", { count: batchFileIds.length })
                    : t("batch.selectAll")}
                </span>
              </label>
              <DropMenu<MetaAction>
                ariaLabel={t("batch.metaMenu")}
                triggerIcon={<Tags className="h-3.5 w-3.5" strokeWidth={1.75} />}
                triggerClassName="text-foreground-muted hover:text-foreground"
                placement="bottom"
                disabled={batchFileIds.length === 0}
                items={[
                  { key: "newspaper", label: t("batch.setNewspaper"), variant: "action" },
                  { key: "addTag", label: t("batch.addTag"), variant: "action" },
                  { key: "removeTag", label: t("batch.removeTag"), variant: "action" },
                ]}
                onSelect={setMetaEditor}
              />
              <button
                type="button"
                onClick={exitSelecting}
                className="h-6 shrink-0 rounded px-2 text-foreground-muted hover:bg-surface hover:text-foreground"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => setBatchDialogOpen(true)}
                disabled={batchFileIds.length === 0}
                className="h-6 shrink-0 rounded bg-primary px-2 font-medium text-primary-foreground hover:bg-primary/90 active:bg-primary/80 disabled:cursor-default disabled:opacity-50"
              >
                {t("batch.exportSelected")}
              </button>
            </div>
          )}

          {selecting && metaEditor && batchFileIds.length > 0 && (
            <BatchMetaEditor
              key={metaEditor}
              action={metaEditor}
              fileIds={batchFileIds}
              onDone={() => setMetaEditor(null)}
            />
          )}

          {files.length === 0 ? (
            <button
              type="button"
              onClick={() => void onOpenFiles()}
              className="w-full rounded-md px-3 py-3 text-center text-[11px] leading-5 text-foreground-subtle transition-colors hover:bg-surface-2 hover:text-foreground-muted focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              {t("queue.addFile")}
            </button>
          ) : (
            <div
              role="grid"
              aria-label={t("queue.title")}
              onKeyDown={onListKeyDown}
              className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain pb-3 pr-1"
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
                  onRemove={selecting ? undefined : removeFile}
                  checked={selecting ? checkedIds.includes(entry.id) : undefined}
                  onToggleCheck={toggleChecked}
                />
              ))}
            </div>
          )}
      </div>

      <div className="border-t border-border/50 px-1.5 pt-1.5">
          <BatchExportStatus />
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
      <BatchExportDialog
        open={batchDialogOpen}
        fileIds={batchFileIds}
        onClose={closeBatchDialog}
        onStarted={exitSelecting}
      />
    </aside>
  );
}

type MetaAction = "newspaper" | "addTag" | "removeTag";

/** Stable fallback for files that have no document state yet. */
const NO_TAGS: string[] = [];

/** Inline editor under the selection bar for one batch metadata action.
 *  Suggestions come from the session itself: newspaper names and tags
 *  already used on any queued file (for removal: tags on the selection). */
function BatchMetaEditor({
  action,
  fileIds,
  onDone,
}: {
  action: MetaAction;
  fileIds: string[];
  onDone: () => void;
}) {
  const t = useT();
  const files = useStore((s) => s.files);
  const documentStates = useStore((s) => s.documentStates);
  const setNewspaperNameForFiles = useStore((s) => s.setNewspaperNameForFiles);
  const addTagToFiles = useStore((s) => s.addTagToFiles);
  const removeTagFromFiles = useStore((s) => s.removeTagFromFiles);
  const [value, setValue] = useState("");

  const suggestions = useMemo(() => {
    const source =
      action === "removeTag" ? fileIds : files.map((f) => f.id);
    const values = source.flatMap((id) => {
      const doc = documentStates[id];
      if (action === "newspaper") return doc?.newspaperName ? [doc.newspaperName] : [];
      return doc?.tags ?? NO_TAGS;
    });
    return [...new Set(values)].sort((a, b) =>
      a.localeCompare(b, "zh-Hans-CN", { numeric: true })
    );
  }, [action, fileIds, files, documentStates]);

  const apply = (next: string) => {
    if (action === "newspaper") setNewspaperNameForFiles(fileIds, next);
    else if (action === "addTag") addTagToFiles(fileIds, next);
    else removeTagFromFiles(fileIds, next);
    onDone();
  };
  const canApply = action === "newspaper" || value.trim().length > 0;

  return (
    <div className="mb-1.5 flex shrink-0 flex-col gap-1.5 rounded-md border border-border/60 bg-surface px-1.5 py-1.5 text-[11px]">
      {action !== "removeTag" && (
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (isImeCommit(e)) return;
              if (e.key === "Enter" && canApply) {
                e.preventDefault();
                apply(value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onDone();
              }
            }}
            placeholder={
              action === "newspaper"
                ? t("batch.newspaperPlaceholder")
                : t("batch.tagPlaceholder")
            }
            aria-label={
              action === "newspaper" ? t("batch.setNewspaper") : t("batch.addTag")
            }
            className="h-6 min-w-0 flex-1 rounded border border-border/60 bg-background px-1.5 text-[12px] text-foreground outline-none placeholder:text-foreground-placeholder focus:border-border-strong"
          />
          <button
            type="button"
            onClick={() => apply(value)}
            disabled={!canApply}
            className="h-6 shrink-0 rounded bg-primary px-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t("batch.apply")}
          </button>
        </div>
      )}
      {suggestions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {suggestions.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => apply(item)}
              className="max-w-full truncate rounded bg-surface-2 px-1.5 leading-5 text-foreground-muted hover:bg-surface-overlay hover:text-foreground"
            >
              {item}
            </button>
          ))}
        </div>
      ) : (
        action === "removeTag" && (
          <span className="text-foreground-subtle">{t("batch.noTagsOnSelection")}</span>
        )
      )}
      {action === "removeTag" && (
        <button
          type="button"
          onClick={onDone}
          className="self-end rounded px-2 leading-5 text-foreground-muted hover:bg-surface-2 hover:text-foreground"
        >
          {t("common.cancel")}
        </button>
      )}
    </div>
  );
}
