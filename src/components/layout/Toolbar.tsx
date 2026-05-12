import { useEffect, useRef, useState } from "react";
import { ScanText, Square } from "lucide-react";
import { useStore } from "@/store";
import { useWholeFileOcrTrigger } from "@/hooks/useWholeFileOcrTrigger";

export function Toolbar() {
  const currentFile = useStore((s) =>
    s.currentFileId ? s.files.find((f) => f.id === s.currentFileId) ?? null : null
  );
  const recognitionMode = useStore((s) => s.recognitionMode);
  const setRecognitionMode = useStore((s) => s.setRecognitionMode);
  const manualDrawMode = useStore((s) => s.manualDrawMode);
  const toggleDrawMode = useStore((s) => s.toggleDrawMode);
  const setDrawMode = useStore((s) => s.setDrawMode);

  const { state: triggerState } = useWholeFileOcrTrigger();

  if (!currentFile) return null;

  const groupedActive = recognitionMode === "grouped";

  return (
    <div className="flex h-6 items-center gap-2 rounded-md border border-border/60 bg-background/80 px-2.5 shadow-sm backdrop-blur-sm">
      <h1 className="max-w-[240px] truncate text-[12px] font-semibold leading-none text-foreground">
        {currentFile.name}
      </h1>

      <div className="h-3 w-px bg-border" />

      {groupedActive && (
        <button
          type="button"
          onClick={toggleDrawMode}
          className={`flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium leading-none transition-colors ${
            manualDrawMode
              ? "bg-primary-muted text-foreground"
              : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
          }`}
          title="切换框选模式（V）"
        >
          <Square className="h-3 w-3" />
          <span>{manualDrawMode ? "退出框选" : "框选识别"}</span>
        </button>
      )}

      <button
        type="button"
        onClick={() => {
          if (groupedActive) {
            setRecognitionMode("whole_file");
          } else {
            setRecognitionMode("grouped");
            setDrawMode(false);
          }
        }}
        title={groupedActive ? "进入全文识别模式" : "返回框选模式"}
        className={`flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium leading-none transition-colors ${
          groupedActive
            ? "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
            : "bg-primary-muted text-foreground"
        }`}
      >
        <ScanText className="h-3 w-3" />
        <span>{groupedActive ? "全文识别" : "返回框选"}</span>
      </button>

      {recognitionMode === "whole_file" && triggerState.showRange && (
        <>
          <div className="h-3 w-px bg-border" />
          <PageRangeChip
            totalPages={triggerState.totalPages}
            range={triggerState.range}
          />
        </>
      )}

      {recognitionMode === "whole_file" && triggerState.error && (
        <span
          className="ml-1 max-w-[260px] truncate text-[11px] text-destructive"
          role="alert"
          title={triggerState.error}
        >
          {triggerState.error}
        </span>
      )}
    </div>
  );
}

function PageRangeChip({
  totalPages,
  range,
}: {
  totalPages: number;
  range: { from: number; to: number } | null;
}) {
  const fileId = useStore((s) => s.currentFileId);
  const setRange = useStore((s) => s.setWholeFileRange);
  const [open, setOpen] = useState(false);

  const from = range?.from ?? 1;
  const to = range?.to ?? totalPages;
  const isFull = range === null;
  const label = isFull
    ? `第 1–${totalPages} 页 · 全部`
    : `第 ${from}–${to} 页`;

  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  useEffect(() => {
    if (open) {
      setDraftFrom(from);
      setDraftTo(to);
    }
  }, [open, from, to]);

  function commit() {
    if (!fileId) return;
    const a = Math.max(1, Math.min(totalPages, Math.floor(draftFrom)));
    const b = Math.max(a, Math.min(totalPages, Math.floor(draftTo)));
    if (a === 1 && b === totalPages) {
      setRange(fileId, null);
    } else {
      setRange(fileId, { from: a, to: b });
    }
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="点击修改页码范围"
        className={`flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-mono leading-none tabular-nums transition-colors ${
          isFull
            ? "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
            : "bg-primary-muted text-foreground"
        }`}
      >
        {label}
      </button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-30 w-[240px] rounded-md border border-border/70 bg-background p-2 shadow-lg">
          <div className="mb-2 flex items-center justify-between text-[11px] text-foreground-muted">
            <span>页码范围</span>
            <span className="font-mono tabular-nums">
              共 {totalPages} 页
            </span>
          </div>
          <div className="mb-2 flex items-center gap-1.5 text-[12px] text-foreground">
            <span className="text-[11px] text-foreground-muted">从</span>
            <input
              type="number"
              min={1}
              max={totalPages}
              value={draftFrom}
              onChange={(e) => setDraftFrom(parseInt(e.target.value, 10) || 1)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
              }}
              className="h-6 w-14 rounded border border-border/60 bg-surface px-1.5 font-mono text-[12px] tabular-nums outline-none focus:border-border-strong"
            />
            <span className="text-[11px] text-foreground-muted">到</span>
            <input
              type="number"
              min={draftFrom}
              max={totalPages}
              value={draftTo}
              onChange={(e) => setDraftTo(parseInt(e.target.value, 10) || 1)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
              }}
              className="h-6 w-14 rounded border border-border/60 bg-surface px-1.5 font-mono text-[12px] tabular-nums outline-none focus:border-border-strong"
            />
          </div>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                if (fileId) setRange(fileId, null);
                setOpen(false);
              }}
              className="text-[11px] text-foreground-muted hover:text-foreground hover:underline"
            >
              重置为全部
            </button>
            <button
              type="button"
              onClick={commit}
              className="h-6 rounded bg-primary px-2 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90"
            >
              确定
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
