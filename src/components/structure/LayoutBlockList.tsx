import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { layoutCanvasMapping, type LayoutPage } from "@/lib/layout-document";
import { useStore } from "@/store";
import { useT } from "@/i18n";

interface LayoutBlockListProps {
  fileId: string;
  page: number;
  layout: LayoutPage;
}

type Drafts = Record<number, string>;

function buildDrafts(layout: LayoutPage): Drafts {
  return Object.fromEntries(
    layout.blocks.map((block, index) => [index, block.text])
  );
}

function estimateRows(text: string): number {
  const lineCount = text.split(/\r\n|\r|\n/).length;
  const wrappedCount = Math.ceil(text.length / 42);
  return Math.min(18, Math.max(2, lineCount, wrappedCount));
}

export function LayoutBlockList({ fileId, page, layout }: LayoutBlockListProps) {
  const t = useT();
  const updateLayoutBlockText = useStore((s) => s.updateLayoutBlockText);
  const setEditingLayoutBlock = useStore((s) => s.setEditingLayoutBlock);
  // The rendered bitmap's native size, which is what the canvas draws at. Used
  // only to decide whether to warn that the canvas cannot locate these blocks;
  // the canvas does its own mapping. Selected as two primitives rather than as
  // one `{ width, height }`: a selector returning a fresh object fails zustand's
  // `Object.is` check on every store write, which would re-render this whole
  // list of textareas on every debounced edit and every OCR progress tick.
  const imageWidth = useStore(
    (s) => s.files.find((f) => f.id === fileId)?.payload?.width ?? null
  );
  const imageHeight = useStore(
    (s) => s.files.find((f) => f.id === fileId)?.payload?.height ?? null
  );
  // A missing bitmap is a transient state during page load, not a broken page,
  // so it must not raise the warning.
  const cannotLocate =
    imageWidth !== null &&
    imageHeight !== null &&
    layoutCanvasMapping(layout, {
      width: imageWidth,
      height: imageHeight,
    }) === null;
  // The page maps, but off a size the importer inferred rather than read.
  // Saying so is the difference between "this box is where the block is" and
  // "this box is roughly where the block is" — and the whole point of the
  // block list is that the first claim can be trusted.
  const approximate = !cannotLocate && !!layout.dimensionsApproximate;
  const [drafts, setDrafts] = useState<Drafts>(() => buildDrafts(layout));
  const writeBackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWritesRef = useRef(new Map<number, () => void>());

  const orderedBlocks = useMemo(
    () =>
      layout.blocks
        .map((block, index) => ({ block, index }))
        .sort((a, b) => (a.block.order ?? a.index) - (b.block.order ?? b.index)),
    [layout.blocks]
  );

  const flushWriteBack = useCallback(() => {
    if (writeBackTimerRef.current !== null) {
      clearTimeout(writeBackTimerRef.current);
      writeBackTimerRef.current = null;
    }
    const commits = Array.from(pendingWritesRef.current.values());
    pendingWritesRef.current.clear();
    commits.forEach((commit) => commit());
  }, []);

  const scheduleWriteBack = useCallback(
    (blockIndex: number, value: string) => {
      const commit = () => updateLayoutBlockText(fileId, page, blockIndex, value);
      if (writeBackTimerRef.current !== null) {
        clearTimeout(writeBackTimerRef.current);
      }
      pendingWritesRef.current.set(blockIndex, commit);
      writeBackTimerRef.current = setTimeout(() => {
        writeBackTimerRef.current = null;
        const commits = Array.from(pendingWritesRef.current.values());
        pendingWritesRef.current.clear();
        commits.forEach((pendingCommit) => pendingCommit());
      }, 400);
    },
    [fileId, page, updateLayoutBlockText]
  );

  useEffect(() => () => flushWriteBack(), [flushWriteBack]);

  // React fires no blur when a focused field is unmounted, so leaving the block
  // view (or turning the page) while a textarea has focus would leave the
  // canvas highlighting a block nobody is editing.
  useEffect(
    () => () => setEditingLayoutBlock(fileId, null),
    [fileId, setEditingLayoutBlock]
  );

  useEffect(() => {
    if (pendingWritesRef.current.size === 0) {
      setDrafts(buildDrafts(layout));
    }
  }, [layout]);

  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-md border border-border/40 bg-background px-2.5 py-2">
      <p className="mb-2 px-0.5 text-[10px] text-foreground-muted">
        {t("blocks.hint")}
      </p>
      {cannotLocate && (
        <p
          className="mb-2 rounded border border-border/40 bg-surface-2 px-1.5 py-1 text-[10px] text-foreground-muted"
          role="status"
        >
          {t("blocks.noCanvasMapping")}
        </p>
      )}
      {approximate && (
        <p
          className="mb-2 rounded border border-border/40 bg-surface-2 px-1.5 py-1 text-[10px] text-foreground-muted"
          role="status"
        >
          {t("blocks.approximateMapping")}
        </p>
      )}
      <div className="flex flex-col gap-2">
        {orderedBlocks.map(({ block, index }) => {
          const value = drafts[index] ?? "";
          const isImageBlock = !!block.imageRef;
          // The label / order pair above the field is visual only, and the
          // page image itself is a <canvas> a screen reader cannot describe.
          // Without this the field announces as an unlabelled text area and
          // there is no way to tell which block is being edited.
          const blockLabel =
            typeof block.order === "number"
              ? t("blocks.blockLabelOrdered", {
                  label: block.label,
                  order: block.order,
                })
              : t("blocks.blockLabel", { label: block.label });
          return (
            <div key={index} className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] text-foreground-subtle">
                  {block.label}
                </span>
                {typeof block.order === "number" && (
                  <span className="font-mono text-[10px] text-foreground-subtle">
                    #{block.order}
                  </span>
                )}
              </div>
              {isImageBlock ? (
                <div className="rounded-md border border-border/40 bg-surface-2 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-foreground-muted">
                  {t("blocks.imageBlock")}
                </div>
              ) : (
                <textarea
                  aria-label={blockLabel}
                  value={value}
                  rows={estimateRows(value)}
                  // Focus, not click: tabbing between blocks moves the canvas
                  // highlight too, so the feature is not mouse-only.
                  onFocus={() => setEditingLayoutBlock(fileId, { page, index })}
                  onBlur={() => setEditingLayoutBlock(fileId, null)}
                  onChange={(e) => {
                    const nextValue = e.target.value;
                    setDrafts((prev) => ({ ...prev, [index]: nextValue }));
                    scheduleWriteBack(index, nextValue);
                  }}
                  spellCheck={false}
                  className="resize-y rounded-md border border-border/40 bg-background px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-foreground outline-none focus:border-border-strong"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
