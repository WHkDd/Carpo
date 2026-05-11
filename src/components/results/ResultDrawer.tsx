import { useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { ChevronDown, Copy, Download, X } from "lucide-react";
import { useStore } from "@/store";

/** Bottom drawer that surfaces the assembled document after grouped OCR
 *  finishes. T5.7's MVP: single-file view (per-file tabs land with M6
 *  batch). Body is a readonly textarea so the user can spot-edit before
 *  copying / saving; edits are local and don't write back to the store.
 *
 *  Source of truth: `documentResults[fileId]`. Visibility: `resultDrawerOpen`.
 *  Open is owned by AppShell's done-listener; close is owned here. */
export function ResultDrawer() {
  const open = useStore((s) => s.resultDrawerOpen);
  const closeDrawer = useStore((s) => s.closeResultDrawer);
  const fileId = useStore((s) => s.currentFileId);
  const documentResults = useStore((s) => s.documentResults);
  const files = useStore((s) => s.files);

  const text = fileId ? documentResults[fileId] ?? "" : "";
  const fileEntry = files.find((f) => f.id === fileId);
  const fileLabel = fileEntry?.name ?? "(未命名)";
  const charCount = useMemo(() => text.length, [text]);

  const [draft, setDraft] = useState(text);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Sync local draft when the upstream result changes — typically only on
  // first open after a finished job, but covers re-runs too.
  useEffect(() => {
    setDraft(text);
  }, [text, fileId]);

  const [copied, setCopied] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!open) return null;

  async function onCopy() {
    try {
      await writeText(draftRef.current);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setSaveError(`复制失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function onSave() {
    setSaveError(null);
    try {
      const defaultName = `${fileLabel.replace(/\.[^.]+$/, "")}.txt`;
      const target = await save({
        defaultPath: defaultName,
        filters: [{ name: "文本", extensions: ["txt"] }],
      });
      if (!target) return;
      await writeTextFile(target, draftRef.current);
    } catch (e) {
      setSaveError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div
      className="fixed inset-x-2 bottom-2 z-30 flex max-h-[60vh] flex-col rounded-[10px] border border-border bg-surface shadow-[0_-12px_40px_-16px_rgba(0,0,0,0.18)]"
      role="dialog"
      aria-label="OCR 结果"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">
            {fileLabel}
          </span>
          <span className="font-mono text-[11px] text-foreground-subtle tabular-nums">
            {charCount.toLocaleString()} 字
          </span>
          {copied && (
            <span className="text-[11px] text-foreground-muted">已复制 ✓</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void onCopy()}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>复制</span>
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>保存</span>
          </button>
          <span className="mx-1 h-3.5 w-px bg-border" aria-hidden />
          <button
            type="button"
            onClick={closeDrawer}
            aria-label="收起结果"
            title="收起"
            className="grid h-7 w-7 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={closeDrawer}
            aria-label="关闭"
            className="grid h-7 w-7 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      </header>
      {saveError && (
        <p className="px-4 py-1.5 text-[11px] text-destructive" role="alert">
          {saveError}
        </p>
      )}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none bg-background px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground outline-none"
      />
    </div>
  );
}
