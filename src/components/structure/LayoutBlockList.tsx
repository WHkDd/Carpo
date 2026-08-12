import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayoutPage } from "@/lib/layout-document";
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
      <div className="flex flex-col gap-2">
        {orderedBlocks.map(({ block, index }) => {
          const value = drafts[index] ?? "";
          const isImageBlock = !!block.imageRef;
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
                  value={value}
                  rows={estimateRows(value)}
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
