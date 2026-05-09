import { useStore } from "@/store";

export function StructureRail() {
  const hasFile = useStore((s) => s.currentFileId !== null);

  return (
    <aside className="grid min-h-0 grid-rows-[28px_minmax(0,1fr)_auto] bg-surface">
      <div aria-hidden />

      <div className="min-h-0 overflow-hidden px-2 pb-2 pt-px">
        <div className="mb-2 flex h-7 items-center justify-between gap-2 px-1.5">
          <span className="text-[13px] font-semibold text-foreground">
            扫描文本结构
          </span>
          <span className="font-mono text-[11px] text-foreground-subtle/80">
            —
          </span>
        </div>

        <p className="px-1.5 text-[12px] leading-5 text-foreground-subtle">
          {hasFile
            ? "完成版块标注后，此处将显示报道结构与阅读顺序。"
            : "尚未导入扫描件。"}
        </p>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-3">
        <span className="font-mono text-[11px] text-foreground-subtle tabular-nums">
          批量 —
        </span>
        <button
          type="button"
          disabled
          className="h-8 rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:cursor-default disabled:opacity-50"
        >
          识别选中报道
        </button>
      </div>
    </aside>
  );
}
