import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileJson,
  FileOutput,
  FolderClock,
  Layers,
  Loader2,
  MoreHorizontal,
  Plus,
  ScanText,
  Search,
  Settings as SettingsIcon,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { DropMenu, type DropMenuEntry } from "@/components/ui/DropMenu";
import { useListKeyboard } from "@/hooks/useListKeyboard";
import { alertError, confirmDestructive } from "@/lib/confirm";
import { isImeCommit } from "@/lib/ime";
import { appErrorMessage } from "@/lib/ipc-types";
import { isTauriRuntime, logError } from "@/lib/runtime";
import {
  openProgressSnapshot,
  saveProgressSnapshot,
} from "@/lib/session-snapshot";
import {
  groupQueueFiles,
  sortQueueFiles,
  type QueueSortField,
  type QueueGroupMode,
} from "@/lib/queue-view";
import {
  activateQueueSearchHit,
  INITIAL_SEARCH_HITS,
  queueSearchInput,
  searchDocument,
  searchQueueFile,
  type QueueSearchResult,
} from "@/lib/queue-search";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import { reorderedQueue } from "@/store/queueSlice";
import { useT } from "@/i18n";
import { QueueHighlight, QueueItem, QueueItemCompact } from "./QueueItem";
import { BatchExportDialog, BatchExportStatus } from "./BatchExportDialog";

interface QueuePanelProps {
  onOpenFiles: () => void | Promise<void>;
  onImportPaddleJson: () => void | Promise<void>;
  onOpenSettings: () => void;
}
const ICON_BUTTON =
  "grid place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground active:bg-surface-overlay focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring";

type ContextAction = "star" | MetaAction | "recognize" | "export" | "remove";
type ContextState = {
  ids: string[];
  x: number;
  y: number;
  origin: HTMLElement;
};

/** Portal keeps the right-click menu outside the sidebar's clipping region. */
function QueueContextMenu({
  context,
  items,
  onSelect,
  onClose,
}: {
  context: ContextState;
  items: DropMenuEntry<ContextAction>[];
  onSelect: (action: ContextAction) => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: context.x, top: context.y });
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: Math.max(
        8,
        Math.min(context.x, window.innerWidth - rect.width - 8),
      ),
      top: Math.max(
        8,
        Math.min(context.y, window.innerHeight - rect.height - 8),
      ),
    });
    ref.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }, [context]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const scroll = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !ref.current?.contains(event.target)
      )
        onClose();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={t("queue.actions")}
      style={position}
      className="app-chrome fixed z-[60] max-h-[calc(100vh-16px)] min-w-40 overflow-y-auto rounded-lg border border-border bg-surface p-1 text-[12px] text-foreground shadow-xl"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const buttons = Array.from(
          ref.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? [],
        );
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                  buttons.length;
          buttons[next]?.focus();
        } else if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          context.origin.focus();
        }
      }}
    >
      {items.map((item, index) =>
        "separator" in item ? (
          <div
            key={index}
            role="separator"
            className="my-1 border-t border-border/60"
          />
        ) : (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={item.disabled}
            onClick={() => {
              context.origin.focus();
              onSelect(item.key);
            }}
            className={cn(
              "block w-full rounded px-2 py-1.5 text-left outline-none hover:bg-surface-2 focus:bg-surface-2 disabled:opacity-40",
              item.key === "remove" && "text-destructive",
            )}
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function QueuePanel({
  onOpenFiles,
  onImportPaddleJson,
  onOpenSettings,
}: QueuePanelProps) {
  const t = useT();
  const files = useStore((s) => s.files);
  const documents = useStore((s) => s.documentStates);
  const recognized = useStore((s) => s.recognizedPages);
  const pageTexts = useStore((s) => s.pageOcrTexts);
  const articleTexts = useStore((s) => s.articleOcrTexts);
  const currentFileId = useStore((s) => s.currentFileId);
  const selectedIds = useStore((s) => s.selectedQueueFileIds);
  const manualOrder = useStore((s) => s.manualQueueFileIds);
  const sortField = useStore((s) => s.queueSortField);
  const ascending = useStore((s) => s.queueSortAscending);
  const groupMode = useStore((s) => s.queueGroupMode);
  const query = useStore((s) => s.queueSearchText);
  const setView = useStore((s) => s.setQueueView);
  const setCurrent = useStore((s) => s.setCurrent);
  const selectFile = useStore((s) => s.selectQueueFile);
  const setSelection = useStore((s) => s.setQueueSelection);
  const moveFiles = useStore((s) => s.moveQueueFiles);
  const removeFiles = useStore((s) => s.removeFiles);
  const queueCollapsed = useStore((s) => s.queueCollapsed);
  const toggleQueueCollapsed = useStore((s) => s.toggleQueueCollapsed);
  const setQueueCollapsed = useStore((s) => s.setQueueCollapsed);
  const desktopRuntime = isTauriRuntime();
  const [selecting, setSelecting] = useState(false);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [batchDialogMode, setBatchDialogMode] = useState<BatchAction | null>(
    null,
  );
  const [actionFileIds, setActionFileIds] = useState<string[] | null>(null);
  const [metaEditor, setMetaEditor] = useState<{
    action: MetaAction;
    ids: string[];
  } | null>(null);
  const [context, setContext] = useState<ContextState | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );
  const [expandedHits, setExpandedHits] = useState<Set<string>>(new Set());
  const [searchResults, setSearchResults] = useState<
    Record<string, QueueSearchResult>
  >({});
  const [completedSearch, setCompletedSearch] = useState<{
    input: ReturnType<typeof queueSearchInput>;
    needle: string;
  } | null>(null);
  const [activeHit, setActiveHit] = useState<string | null>(null);
  const [insertion, setInsertion] = useState<{
    key: string;
    after: boolean;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearch = useRef(false);
  const dragIds = useRef<string[]>([]);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const needle = useMemo(() => searchDocument(query).folded, [query]);
  const searching = !!needle;
  const fileNamesKey = JSON.stringify(
    files.map(({ id, name }) => ({ id, name })),
  );
  const input = useMemo(
    () =>
      searching
        ? queueSearchInput(
            JSON.parse(fileNamesKey),
            documents,
            recognized,
            pageTexts,
            articleTexts,
          )
        : [],
    [fileNamesKey, documents, recognized, pageTexts, articleTexts, searching],
  );
  const searchPending =
    searching &&
    (completedSearch?.input !== input || completedSearch.needle !== needle);

  useEffect(() => {
    let cancelled = false;
    setSearchResults({});
    setActiveHit(null);
    setExpandedHits(new Set());
    if (!searching) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        const results: Record<string, QueueSearchResult> = {};
        for (const file of input) {
          if (cancelled) return;
          const result = searchQueueFile(file, needle);
          if (result) results[file.id] = result;
          // Yield between files: typing or canvas navigation cancels stale work.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
        if (!cancelled) {
          setSearchResults(results);
          setCompletedSearch({ input, needle });
        }
      })();
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [input, needle, searching]);

  const sorted = useMemo(
    () => sortQueueFiles(files, documents, manualOrder, sortField, ascending),
    [files, documents, manualOrder, sortField, ascending],
  );
  const filtered = useMemo(
    () =>
      searching ? sorted.filter((file) => searchResults[file.id]) : sorted,
    [sorted, searching, searchResults],
  );
  const sections = groupQueueFiles(filtered, documents, groupMode);
  const primaryRows = new Map<string, string>();
  if (queueCollapsed)
    for (const file of filtered) primaryRows.set(file.id, file.id);
  else
    for (const section of sections) {
      if (collapsedGroups.has(section.id)) continue;
      for (const file of section.files)
        if (!primaryRows.has(file.id))
          primaryRows.set(file.id, `${section.id}:${file.id}`);
    }
  const visibleIdsKey = JSON.stringify([...primaryRows.keys()]);
  const visibleIds: string[] = useMemo(
    () => JSON.parse(visibleIdsKey),
    [visibleIdsKey],
  );
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectableIds = useMemo(
    () => filtered.filter((file) => !file.loadError).map((file) => file.id),
    [filtered],
  );
  const batchFileIds = useMemo(
    () => selectableIds.filter((id) => checkedIds.includes(id)),
    [selectableIds, checkedIds],
  );
  const allChecked =
    selectableIds.length > 0 && batchFileIds.length === selectableIds.length;
  const canReorder =
    sortField === "manual" && groupMode === "none" && !searching && !selecting;
  const activeIndex = visibleIds.indexOf(currentFileId ?? "");
  const tabbableIndex = activeIndex >= 0 ? activeIndex : 0;

  // A settled filter trims selection. Never trim against an unfinished search.
  useEffect(() => {
    if (searchPending) return;
    const ids = new Set(filtered.map((file) => file.id));
    const next = selectedIds.filter((id) => ids.has(id));
    if (next.length !== selectedIds.length) setSelection(next);
  }, [filtered, selectedIds, searchPending, setSelection]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.altKey &&
        event.code === "KeyF" &&
        !event.isComposing
      ) {
        event.preventDefault();
        if (queueCollapsed) {
          focusSearch.current = true;
          setQueueCollapsed(false);
        } else {
          searchRef.current?.focus();
          searchRef.current?.select();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queueCollapsed, setQueueCollapsed]);
  useEffect(() => {
    if (!queueCollapsed && focusSearch.current) {
      focusSearch.current = false;
      searchRef.current?.focus();
    }
  }, [queueCollapsed]);

  const toggleChecked = useCallback(
    (id: string) => {
      if (!selectableIds.includes(id)) return;
      setCheckedIds((prev) =>
        prev.includes(id) ? prev.filter((key) => key !== id) : [...prev, id],
      );
    },
    [selectableIds],
  );
  const enterSelecting = () => {
    setCheckedIds(
      selectedIds.length > 1
        ? selectedIds.filter((id) => selectableIds.includes(id))
        : [],
    );
    setSelecting(true);
  };
  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setCheckedIds([]);
    setBatchDialogMode(null);
    setActionFileIds(null);
    setMetaEditor(null);
  }, []);
  const closeBatchDialog = useCallback(() => {
    setBatchDialogMode(null);
    setActionFileIds(null);
  }, []);
  const exportRecognized = useCallback((ids: string[]) => {
    setActionFileIds(ids);
    setBatchDialogMode("export");
  }, []);
  const chooseFile = (id: string, event: React.MouseEvent<HTMLDivElement>) => {
    setActiveHit(null);
    if (selecting) setCurrent(id);
    else
      selectFile(
        id,
        visibleIds,
        event.metaKey || event.ctrlKey,
        event.shiftKey,
      );
  };
  const requestRemoval = useCallback(
    async (ids: string[]) => {
      const unique = [...new Set(ids)].filter((id) =>
        useStore.getState().files.some((file) => file.id === id),
      );
      if (!unique.length) return;
      if (
        await confirmDestructive({
          title: t("queue.remove"),
          message: t("queue.confirmRemove", { count: unique.length }),
          confirmLabel: t("queue.remove"),
        })
      ) {
        removeFiles(
          unique,
          filtered.map((file) => file.id),
        );
        window.requestAnimationFrame(() => {
          const current = useStore.getState().currentFileId;
          const row = [
            ...document.querySelectorAll<HTMLElement>("[data-queue-id]"),
          ].find((element) => element.dataset.queueId === current);
          row?.querySelector<HTMLElement>('[role="gridcell"]')?.focus();
        });
      }
    },
    [removeFiles, filtered, t],
  );
  const moveSelection = (delta: number) => {
    if (!canReorder) return;
    const positions = sorted.flatMap((file, index) =>
      selected.has(file.id) ? [index] : [],
    );
    if (!positions.length) return;
    const edge = delta < 0 ? positions[0]! : positions.at(-1)!;
    const target = sorted[edge + delta];
    if (target) moveFiles(selectedIds, target.id, delta > 0);
  };
  const { onKeyDown } = useListKeyboard({
    itemCount: visibleIds.length,
    activeIndex,
    onSelect: useCallback(
      (index: number) => {
        const id = visibleIds[index];
        if (id) selectFile(id, visibleIds);
      },
      [visibleIds, selectFile],
    ),
    labelAt: useCallback(
      (index: number) =>
        files.find((file) => file.id === visibleIds[index])?.name ?? "",
      [files, visibleIds],
    ),
    focusAt: useCallback(
      (index: number) => rowRefs.current[index]?.focus(),
      [],
    ),
  });
  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (
      isImeCommit(event) ||
      (event.target instanceof Element && event.target.closest("button, input"))
    )
      return;
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      const origin = rowRefs.current[activeIndex];
      if (origin && currentFileId) {
        event.preventDefault();
        const rect = origin.getBoundingClientRect();
        openContext(currentFileId, origin, rect.left + 20, rect.bottom);
      }
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      event.altKey &&
      ["ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      event.preventDefault();
      moveSelection(event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      if (selecting)
        setCheckedIds((previous) => [
          ...new Set([...previous, ...selectableIds]),
        ]);
      else setSelection(visibleIds);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      if (!selecting)
        void requestRemoval(
          selectedIds.filter((id) => visibleIds.includes(id)),
        );
      return;
    }
    if (selecting && event.key === " ") {
      event.preventDefault();
      const id = visibleIds[activeIndex];
      if (id) toggleChecked(id);
      return;
    }
    if (
      event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? visibleIds.length - 1
            : Math.max(
                0,
                Math.min(
                  visibleIds.length - 1,
                  activeIndex + (event.key === "ArrowUp" ? -1 : 1),
                ),
              );
      const id = visibleIds[next];
      if (id) {
        selectFile(id, visibleIds, false, true);
        rowRefs.current[next]?.focus();
      }
      return;
    }
    onKeyDown(event);
  };
  const openContext = (
    id: string,
    origin: HTMLElement,
    x: number,
    y: number,
  ) => {
    const ids = selected.has(id)
      ? selectedIds.filter((key) => filtered.some((file) => file.id === key))
      : [id];
    setContext({ ids, x, y, origin });
  };
  const runContext = (action: ContextAction) => {
    if (!context) return;
    const ids = context.ids;
    setContext(null);
    if (action === "star")
      useStore
        .getState()
        .setQueueStarred(
          ids,
          !files
            .filter((file) => ids.includes(file.id))
            .every((file) => file.isStarred),
        );
    else if (action === "remove") void requestRemoval(ids);
    else if (action === "recognize" || action === "export") {
      setActionFileIds(
        ids.filter((id) => !files.find((file) => file.id === id)?.loadError),
      );
      setBatchDialogMode(action);
    } else {
      setQueueCollapsed(false);
      setMetaEditor({ action, ids });
    }
  };
  const contextFiles = files.filter((file) => context?.ids.includes(file.id));
  const contextItems: DropMenuEntry<ContextAction>[] = [
    {
      key: "star",
      label: t(
        contextFiles.every((file) => file.isStarred)
          ? "queue.unstar"
          : "queue.star",
      ),
      variant: "action",
    },
    { separator: true },
    { key: "newspaper", label: t("batch.setNewspaper"), variant: "action" },
    { key: "date", label: t("queue.setDate"), variant: "action" },
    { key: "addTag", label: t("batch.addTag"), variant: "action" },
    {
      key: "removeTag",
      label: t("batch.removeTag"),
      variant: "action",
      disabled: !contextFiles.some((file) => documents[file.id]?.tags.length),
    },
    { separator: true },
    {
      key: "recognize",
      label: t("queue.recognize"),
      variant: "action",
      disabled: !contextFiles.some((file) => !file.loadError),
    },
    {
      key: "export",
      label: t("queue.export"),
      variant: "action",
      disabled: !contextFiles.some((file) => !file.loadError),
    },
    { separator: true },
    { key: "remove", label: t("queue.remove"), variant: "action" },
  ];
  const renderRow = (
    entry: (typeof files)[number],
    key: string,
    compact = false,
  ) => {
    const result = searchResults[entry.id];
    const index = visibleIds.indexOf(entry.id);
    const common = {
      entry,
      active: selected.has(entry.id),
      tabbable: index === tabbableIndex && primaryRows.get(entry.id) === key,
      onSelect: chooseFile,
      ref: (node: HTMLDivElement | null) => {
        if (primaryRows.get(entry.id) === key) rowRefs.current[index] = node;
      },
    };
    return (
      <div
        key={key}
        data-queue-id={entry.id}
        className={cn(
          "relative",
          insertion?.key === key &&
            (insertion.after
              ? "after:absolute after:z-10 after:inset-x-1 after:bottom-0 after:h-0.5 after:bg-primary"
              : "before:absolute before:z-10 before:inset-x-1 before:top-0 before:h-0.5 before:bg-primary"),
        )}
        onContextMenu={(event) => {
          event.preventDefault();
          const origin =
            event.currentTarget.querySelector<HTMLElement>(
              '[role="gridcell"]',
            ) ?? event.currentTarget;
          openContext(entry.id, origin, event.clientX, event.clientY);
        }}
        draggable={canReorder}
        onDragStart={(event) => {
          const ids = selected.has(entry.id) ? selectedIds : [entry.id];
          const chosen = sorted.filter((file) => ids.includes(file.id));
          if (
            !canReorder ||
            chosen.some((file) => !!file.isStarred !== !!entry.isStarred)
          ) {
            event.preventDefault();
            return;
          }
          dragIds.current = ids;
          setSelection(ids);
          setCurrent(entry.id);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(
            "application/x-carpo-queue",
            JSON.stringify(ids),
          );
          const preview = document.createElement("div");
          preview.textContent = `${entry.kind === "pdf" ? "▤" : "▧"}  ${entry.name}${ids.length > 1 ? `  (${ids.length})` : ""}`;
          preview.className =
            "fixed -left-[9999px] top-0 max-w-64 truncate rounded bg-primary px-3 py-2 text-sm text-primary-foreground";
          document.body.appendChild(preview);
          event.dataTransfer.setDragImage(preview, 12, 16);
          window.requestAnimationFrame(() => preview.remove());
        }}
        onDragOver={(event) => {
          if (!canReorder || !dragIds.current.length) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const after = event.clientY > rect.top + rect.height / 2;
          if (!reorderedQueue(sorted, dragIds.current, entry.id, after)) {
            event.dataTransfer.dropEffect = "none";
            setInsertion(null);
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          if (insertion?.key !== key || insertion.after !== after)
            setInsertion({ key, after });
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setInsertion(null);
        }}
        onDrop={(event) => {
          if (!dragIds.current.length) return;
          event.preventDefault();
          event.stopPropagation();
          if (insertion?.key === key)
            moveFiles(dragIds.current, entry.id, insertion.after);
          dragIds.current = [];
          setInsertion(null);
        }}
        onDragEnd={() => {
          dragIds.current = [];
          setInsertion(null);
        }}
      >
        {compact ? (
          <QueueItemCompact {...common} />
        ) : (
          <QueueItem
            {...common}
            nameRanges={result?.nameRanges}
            newspaperRanges={result?.newspaperRanges}
            checked={selecting ? checkedIds.includes(entry.id) : undefined}
            onToggleCheck={toggleChecked}
          />
        )}
        {!compact && searching && result && result.hits.length > 0 && (
          <div className="ml-11 space-y-0.5 border-l border-border/60 pb-1 pl-2">
            {(expandedHits.has(entry.id)
              ? result.hits
              : result.hits.slice(0, INITIAL_SEARCH_HITS)
            ).map((hit) => (
              <button
                key={hit.id}
                type="button"
                onClick={() => {
                  activateQueueSearchHit(useStore.getState(), hit);
                  setActiveHit(hit.id);
                }}
                className={cn(
                  "block w-full rounded px-1.5 py-1 text-left text-[11px] leading-4 focus-visible:outline focus-visible:outline-ring",
                  activeHit === hit.id
                    ? "bg-primary/10 text-foreground"
                    : "text-foreground-muted hover:bg-surface-2",
                )}
              >
                <span className="block truncate font-medium">
                  <QueueHighlight
                    text={
                      hit.target.kind === "page"
                        ? t("queue.searchPage", { page: hit.target.page })
                        : hit.title || t("queue.untitledArticle")
                    }
                    ranges={hit.titleRanges}
                  />
                </span>
                {hit.excerpt && (
                  <span className="line-clamp-2 break-words">
                    <QueueHighlight
                      text={hit.excerpt}
                      ranges={hit.excerptRanges}
                    />
                  </span>
                )}
              </button>
            ))}
            {result.hits.length > INITIAL_SEARCH_HITS && (
              <button
                type="button"
                className="px-1.5 py-1 text-[11px] text-foreground-subtle hover:text-foreground"
                onClick={() =>
                  setExpandedHits((previous) => {
                    const next = new Set(previous);
                    if (next.has(entry.id)) next.delete(entry.id);
                    else next.add(entry.id);
                    return next;
                  })
                }
              >
                {t(
                  expandedHits.has(entry.id)
                    ? "queue.fewerHits"
                    : "queue.moreHits",
                  { count: result.hits.length - INITIAL_SEARCH_HITS },
                )}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };
  const dialogs = (
    <>
      <BatchExportDialog
        open={batchDialogMode !== null}
        fileIds={actionFileIds ?? batchFileIds}
        recognizeOnly={batchDialogMode === "recognize"}
        onClose={closeBatchDialog}
        onStarted={exitSelecting}
      />
      {context && (
        <QueueContextMenu
          context={context}
          items={contextItems}
          onSelect={runContext}
          onClose={() => setContext(null)}
        />
      )}
    </>
  );

  if (queueCollapsed)
    return (
      <aside className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-surface pb-2">
        <div className="flex min-h-0 flex-col overflow-hidden px-2 pb-2">
          <div className="mb-2 flex h-7 shrink-0 items-center justify-center">
            <button
              type="button"
              onClick={() => void onOpenFiles()}
              aria-label={t("queue.addFile")}
              className={`h-5 w-5 ${ICON_BUTTON}`}
            >
              <Plus className="h-3 w-3" />
            </button>
            <QueueActionsMenu
              more
              onImportPaddleJson={onImportPaddleJson}
              onBatch={() => {
                setQueueCollapsed(false);
                enterSelecting();
              }}
            />
            <button
              type="button"
              onClick={toggleQueueCollapsed}
              aria-label={t("queue.expand")}
              className={`h-5 w-5 ${ICON_BUTTON}`}
            >
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          <div
            role="grid"
            aria-label={t("queue.title")}
            aria-multiselectable="true"
            onKeyDown={onListKeyDown}
            className="min-h-0 space-y-1 overflow-y-auto px-0.5 pb-3 pt-0.5"
          >
            {filtered.map((entry) => renderRow(entry, entry.id, true))}
          </div>
        </div>
        <div className="grid place-items-center border-t border-border/50 px-2 pt-1.5">
          <BatchExportStatus compact />
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label={t("common.settings")}
            className={`h-8 w-14 ${ICON_BUTTON}`}
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
        </div>
        {dialogs}
      </aside>
    );

  return (
    <aside className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-surface pb-2">
      <div className="flex min-h-0 flex-col overflow-hidden px-2 pb-2">
        <div className="mb-2 flex h-7 shrink-0 items-center justify-between gap-1 px-1.5 text-[11px] font-semibold text-foreground-subtle">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{t("queue.title")}</span>
            <span className="font-mono tabular-nums">
              {files.length || t("queue.empty")}
            </span>
          </div>
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => void onOpenFiles()}
              aria-label={t("queue.addFile")}
              className={`h-6 w-6 ${ICON_BUTTON}`}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            {desktopRuntime && (
              <button
                type="button"
                onClick={() => void onImportPaddleJson()}
                aria-label={t("queue.importPaddleJson")}
                className={`h-6 w-6 ${ICON_BUTTON}`}
              >
                <FileJson className="h-3.5 w-3.5" />
              </button>
            )}
            {desktopRuntime && <QueueActionsMenu />}
            <button
              type="button"
              onClick={() => (selecting ? exitSelecting() : enterSelecting())}
              disabled={!files.length}
              aria-pressed={selecting}
              aria-label={t("batch.button")}
              className={`h-6 w-6 disabled:opacity-40 ${ICON_BUTTON} ${selecting ? "bg-surface-2 text-foreground" : ""}`}
            >
              <FileOutput className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={toggleQueueCollapsed}
              aria-label={t("queue.collapse")}
              className={`h-6 w-6 ${ICON_BUTTON}`}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="mb-2 flex shrink-0 items-center gap-1">
          <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border/70 bg-background px-1.5 focus-within:border-border-strong focus-within:outline focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring [&>input:focus-visible]:![outline-style:none]">
            {searchPending ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-foreground-subtle" />
            ) : (
              <Search className="h-3 w-3 shrink-0 text-foreground-subtle" />
            )}
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) =>
                setView({ queueSearchText: event.target.value })
              }
              placeholder={t("queue.search")}
              aria-label={t("queue.search")}
              className="h-7 min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-foreground-subtle [&::-webkit-search-cancel-button]:hidden"
              onKeyDown={(event) => {
                if (isImeCommit(event)) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  setView({ queueSearchText: "" });
                  event.currentTarget.blur();
                }
              }}
            />
            {query && (
              <button
                type="button"
                aria-label={t("queue.clearSearch")}
                onClick={() => {
                  setView({ queueSearchText: "" });
                  searchRef.current?.focus();
                }}
                className={`h-5 w-5 ${ICON_BUTTON}`}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <DropMenu<QueueSortField | "ascending" | "descending">
            ariaLabel={t("queue.sort")}
            triggerIcon={<ArrowDownUp className="h-3.5 w-3.5" />}
            showChevron={false}
            placement="bottom"
            align="end"
            triggerClassName="px-1.5"
            items={[
              ...(["manual", "date", "name", "newspaper"] as const).map(
                (field) => ({
                  key: field,
                  label: t(`queue.sort.${field}`),
                  selected: field === sortField,
                }),
              ),
              { separator: true },
              {
                key: "ascending",
                label: t("queue.ascending"),
                selected: ascending,
                disabled: sortField === "manual",
              },
              {
                key: "descending",
                label: t("queue.descending"),
                selected: !ascending,
                disabled: sortField === "manual",
              },
            ]}
            onSelect={(key) =>
              key === "ascending" || key === "descending"
                ? setView({ queueSortAscending: key === "ascending" })
                : setView({ queueSortField: key })
            }
          />
          <DropMenu<QueueGroupMode>
            ariaLabel={t("queue.group")}
            triggerIcon={<Layers className="h-3.5 w-3.5" />}
            showChevron={false}
            placement="bottom"
            align="end"
            triggerClassName="px-1.5"
            items={(["none", "newspaper", "tag", "year"] as const).map(
              (mode) => ({
                key: mode,
                label: t(`queue.group.${mode}`),
                selected: mode === groupMode,
              }),
            )}
            onSelect={(key) => setView({ queueGroupMode: key })}
          />
        </div>
        {selecting && files.length > 0 && (
          <div className="mb-1.5 flex shrink-0 flex-col gap-1 rounded-md bg-surface-2/60 px-1.5 py-1 text-[11px]">
            <div className="flex items-center gap-1.5">
              <label className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 text-foreground-muted">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() =>
                    setCheckedIds((previous) =>
                      allChecked
                        ? previous.filter((id) => !selectableIds.includes(id))
                        : [...new Set([...previous, ...selectableIds])],
                    )
                  }
                  aria-label={t("batch.selectAll")}
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                />
                <span className="truncate">
                  {batchFileIds.length
                    ? t("batch.selectedCount", { count: batchFileIds.length })
                    : t("batch.selectAll")}
                </span>
              </label>
              <DropMenu<MetaAction>
                ariaLabel={t("batch.metaMenu")}
                triggerIcon={<Tags className="h-3.5 w-3.5" />}
                placement="bottom"
                disabled={!batchFileIds.length}
                items={[
                  {
                    key: "newspaper",
                    label: t("batch.setNewspaper"),
                    variant: "action",
                  },
                  { key: "date", label: t("queue.setDate"), variant: "action" },
                  {
                    key: "addTag",
                    label: t("batch.addTag"),
                    variant: "action",
                  },
                  {
                    key: "removeTag",
                    label: t("batch.removeTag"),
                    variant: "action",
                  },
                ]}
                onSelect={(action) =>
                  setMetaEditor({ action, ids: batchFileIds })
                }
              />
              <button
                type="button"
                aria-label={t("queue.removeSelected")}
                disabled={!batchFileIds.length}
                onClick={() => void requestRemoval(batchFileIds)}
                className={`h-6 w-6 disabled:opacity-40 ${ICON_BUTTON}`}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            <div className="flex items-center justify-end gap-1">
              <button
                type="button"
                onClick={exitSelecting}
                className="h-6 rounded px-1.5 text-foreground-muted hover:bg-surface"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={!batchFileIds.length}
                onClick={() => setBatchDialogMode("recognize")}
                className="inline-flex h-6 items-center gap-1 rounded border border-border/60 px-1.5 text-foreground-muted hover:bg-surface disabled:opacity-50"
              >
                <ScanText className="h-3 w-3" />
                {t("batch.recognizeSelected")}
              </button>
              <button
                type="button"
                disabled={!batchFileIds.length}
                onClick={() => setBatchDialogMode("export")}
                className="h-6 rounded bg-primary px-1.5 font-medium text-primary-foreground disabled:opacity-50"
              >
                {t("batch.exportSelected")}
              </button>
            </div>
          </div>
        )}
        {metaEditor && (
          <BatchMetaEditor
            key={`${metaEditor.action}:${metaEditor.ids.join(":")}`}
            action={metaEditor.action}
            fileIds={metaEditor.ids.filter((id) =>
              files.some((file) => file.id === id),
            )}
            onDone={() => setMetaEditor(null)}
          />
        )}
        {!files.length ? (
          <button
            type="button"
            onClick={() => void onOpenFiles()}
            className="w-full rounded-md px-3 py-3 text-center text-[11px] text-foreground-subtle hover:bg-surface-2"
          >
            {t("queue.addFile")}
          </button>
        ) : (
          <div
            role="grid"
            aria-label={t("queue.title")}
            aria-multiselectable="true"
            aria-busy={searchPending}
            onKeyDown={onListKeyDown}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3 pl-0.5 pr-1 pt-0.5"
          >
            {!filtered.length && !searchPending && (
              <div
                className="grid h-16 place-items-center text-foreground-subtle"
                role="status"
                aria-label={t("queue.noResults")}
              >
                <Search className="h-5 w-5" />
              </div>
            )}
            {sections.map((section) => (
              <div key={section.id} role="rowgroup" className="mb-1 space-y-1.5">
                {section.title !== null && (
                  <div role="row">
                    <div role="gridcell">
                      <button
                        type="button"
                        aria-expanded={!collapsedGroups.has(section.id)}
                        onClick={() =>
                          setCollapsedGroups((previous) => {
                            const next = new Set(previous);
                            if (next.has(section.id)) next.delete(section.id);
                            else next.add(section.id);
                            return next;
                          })
                        }
                        className="flex h-7 w-full items-center gap-1 px-1 text-left text-[11px] font-medium text-foreground-subtle hover:text-foreground focus-visible:outline focus-visible:outline-ring"
                      >
                        {collapsedGroups.has(section.id) ? (
                          <ChevronRight className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {section.title}
                        </span>
                        <span className="font-mono tabular-nums">
                          {section.files.length}
                        </span>
                      </button>
                    </div>
                  </div>
                )}
                {!collapsedGroups.has(section.id) &&
                  section.files.map((entry) =>
                    renderRow(entry, `${section.id}:${entry.id}`),
                  )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="border-t border-border/50 px-1.5 pt-1.5">
        <BatchExportStatus onExport={exportRecognized} />
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={t("common.settings")}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-[12px] text-foreground-muted hover:bg-surface-2 focus-visible:outline focus-visible:outline-ring"
        >
          <SettingsIcon className="h-3.5 w-3.5" />
          <span>{t("common.settings")}</span>
        </button>
      </div>
      {dialogs}
    </aside>
  );
}

/** 批量识别 runs OCR only; 批量识别导出 also writes the output files. */
type BatchAction = "recognize" | "export";

type MetaAction = "newspaper" | "date" | "addTag" | "removeTag";

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
  const setNewspaperDateForFiles = useStore((s) => s.setNewspaperDateForFiles);
  const addTagToFiles = useStore((s) => s.addTagToFiles);
  const removeTagFromFiles = useStore((s) => s.removeTagFromFiles);
  const [value, setValue] = useState("");

  const suggestions = useMemo(() => {
    const source = action === "removeTag" ? fileIds : files.map((f) => f.id);
    const values = source.flatMap((id) => {
      const doc = documentStates[id];
      if (action === "newspaper")
        return doc?.newspaperName ? [doc.newspaperName] : [];
      if (action === "date")
        return doc?.newspaperDate ? [doc.newspaperDate] : [];
      return doc?.tags ?? NO_TAGS;
    });
    return [...new Set(values)].sort((a, b) =>
      a.localeCompare(b, "zh-Hans-CN", { numeric: true }),
    );
  }, [action, fileIds, files, documentStates]);

  const apply = (next: string) => {
    if (action === "newspaper") setNewspaperNameForFiles(fileIds, next);
    else if (action === "date") setNewspaperDateForFiles(fileIds, next);
    else if (action === "addTag") addTagToFiles(fileIds, next);
    else removeTagFromFiles(fileIds, next);
    onDone();
  };
  const canApply =
    action === "newspaper" || action === "date" || value.trim().length > 0;

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
                : action === "date"
                  ? t("queue.datePlaceholder")
                  : t("batch.tagPlaceholder")
            }
            aria-label={
              action === "newspaper"
                ? t("batch.setNewspaper")
                : action === "date"
                  ? t("queue.setDate")
                  : t("batch.addTag")
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
          <span className="text-foreground-subtle">
            {t("batch.noTagsOnSelection")}
          </span>
        )
      )}
      <button
        type="button"
        onClick={onDone}
        className="self-end rounded px-2 leading-5 text-foreground-muted hover:bg-surface-2 hover:text-foreground"
      >
        {t("common.cancel")}
      </button>
    </div>
  );
}

type SnapshotAction = "save" | "open";
type QueueMenuAction = SnapshotAction | "paddleJson" | "batch";

/** Expanded header: one icon for the progress snapshot (进度快照) — save the
 *  queue and its work to a JSON file, or restore one; desktop only, see
 *  `session-snapshot.ts`. Collapsed rail (`more`): a "⋯" menu that also
 *  carries Paddle JSON import and batch OCR / export, which have no room
 *  for their own icons there. */
function QueueActionsMenu({
  more = false,
  onImportPaddleJson,
  onBatch,
}: {
  more?: boolean;
  onImportPaddleJson?: () => void | Promise<void>;
  onBatch?: () => void;
}) {
  const t = useT();
  const desktop = isTauriRuntime();
  const hasFiles = useStore((s) => s.files.length > 0);
  const setStatusText = useStore((s) => s.setStatusText);

  const run = async (action: SnapshotAction) => {
    try {
      if (action === "save") {
        const count = await saveProgressSnapshot();
        if (count !== null) {
          const saved = t("snapshot.saved", { count });
          setStatusText(saved);
          // Only clear our own message: a problem reported in the meantime
          // has to stay on screen.
          window.setTimeout(() => {
            if (useStore.getState().statusText === saved) setStatusText("");
          }, 3000);
        }
        return;
      }
      const summary = await openProgressSnapshot();
      if (!summary) return;
      // The restored files are visible in the queue; like a file import, the
      // status pill only speaks up about what did not come back cleanly.
      const problems = [
        summary.missing > 0
          ? t("snapshot.missing", { count: summary.missing })
          : null,
        summary.skipped > 0
          ? t("snapshot.skipped", { count: summary.skipped })
          : null,
      ].filter((line): line is string => line !== null);
      if (problems.length > 0) setStatusText(problems.join(" · "));
    } catch (err) {
      const message = appErrorMessage(err);
      void logError(`progress snapshot ${action} failed: ${message}`);
      await alertError({
        title: t(
          action === "save" ? "snapshot.saveFailed" : "snapshot.openFailed",
        ),
        message,
      });
    }
  };

  const items: DropMenuEntry<QueueMenuAction>[] = [];
  if (more) {
    if (desktop && onImportPaddleJson) {
      items.push({
        key: "paddleJson",
        label: t("queue.importPaddleJson"),
        variant: "action",
      });
    }
    if (onBatch) {
      items.push({
        key: "batch",
        label: t("batch.button"),
        variant: "action",
        disabled: !hasFiles,
      });
    }
    if (desktop && items.length > 0) items.push({ separator: true });
  }
  if (desktop) {
    items.push(
      {
        key: "save",
        label: t("snapshot.save"),
        variant: "action",
        disabled: !hasFiles,
      },
      { key: "open", label: t("snapshot.open"), variant: "action" },
    );
  }

  return (
    <DropMenu<QueueMenuAction>
      ariaLabel={t(more ? "queue.more" : "snapshot.menu")}
      triggerIcon={
        more ? (
          <MoreHorizontal className="h-3 w-3" strokeWidth={1.8} />
        ) : (
          <FolderClock className="h-3.5 w-3.5" strokeWidth={1.8} />
        )
      }
      showChevron={false}
      menuClassName="min-w-0"
      triggerClassName={`justify-center rounded-md px-0 text-foreground-muted hover:text-foreground ${
        more ? "h-5 w-5" : "h-6 w-6"
      }`}
      placement="bottom"
      items={items}
      onSelect={(action) => {
        if (action === "paddleJson") void onImportPaddleJson?.();
        else if (action === "batch") onBatch?.();
        else void run(action);
      }}
    />
  );
}
