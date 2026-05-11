import { useStore } from "@/store";
import { MetadataInline } from "@/components/structure/MetadataInline";
import { BlockOpsPanel } from "@/components/structure/BlockOpsPanel";
import { ArticleList } from "@/components/structure/ArticleList";
import { useGroupedOcrTrigger } from "@/hooks/useGroupedOcrTrigger";

export function StructureRail() {
  const fileId = useStore((s) => s.currentFileId) ?? "";
  const docState = useStore((s) => s.getDocumentState(fileId));
  const articles = docState.articles;
  const hasFile = fileId !== "";
  const activeJobRunning = useStore(
    (s) =>
      s.activeJob !== null &&
      (s.activeJob.status === "running" || s.activeJob.status === "cancelling")
  );

  const totalBlocks = articles.reduce(
    (sum, a) => sum + a.blockRefs.length,
    0
  );

  const { state, trigger } = useGroupedOcrTrigger();
  const canTrigger =
    hasFile && state.ready && !state.starting && !activeJobRunning;

  return (
    <aside className="grid min-h-0 grid-rows-[28px_minmax(0,1fr)_auto] bg-surface pb-2">
      <div aria-hidden />

      <div className="min-h-0 overflow-hidden px-2 pt-px pb-2">
        <div className="mb-2 flex h-7 items-center justify-between px-1.5">
          <span className="text-[13px] font-semibold text-foreground">
            扫描文本结构
          </span>
          <span className="font-mono text-[11px] text-foreground-subtle/80 tabular-nums">
            {hasFile ? `${articles.length} · ${totalBlocks}` : "—"}
          </span>
        </div>

        {hasFile ? (
          <div className="flex flex-col gap-3 overflow-y-auto px-1.5 pb-2">
            <MetadataInline />
            <BlockOpsPanel />
            <div className="border-t border-border/40" />
            <ArticleList />
          </div>
        ) : (
          <p className="px-1.5 pt-3 text-[12px] leading-5 text-foreground-subtle">
            完成版块标注后，此处将显示报道结构与阅读顺序。
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1 border-t border-border/60 px-4 py-1.5">
        {state.error && (
          <p
            className="text-[11px] leading-tight text-destructive"
            role="alert"
          >
            {state.error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[12px] text-foreground-subtle tabular-nums">
            批量 —
          </span>
          <button
            type="button"
            disabled={!canTrigger}
            onClick={() => void trigger()}
            className="h-8 rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground transition-opacity hover:bg-primary/90 disabled:cursor-default disabled:opacity-50"
          >
            {state.starting ? "正在启动…" : "识别选中报道"}
          </button>
        </div>
      </div>
    </aside>
  );
}
