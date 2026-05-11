import { useCallback } from "react";
import { useStore } from "@/store";
import { Newspaper } from "lucide-react";

export function BlockOpsPanel() {
  const fileId = useStore((s) => s.currentFileId) ?? "";
  const currentPage = useStore((s) => {
    const file = s.files.find((f) => f.id === fileId);
    return file?.currentPage ?? 1;
  });
  const selectionOrder = useStore((s) => s.getFileSelectionOrder(fileId));
  const canMark = selectionOrder.length >= 1;
  const markSelectionAsArticle = useStore((s) => s.markSelectionAsArticle);

  const handleMark = useCallback(() => {
    if (!canMark) return;
    markSelectionAsArticle(fileId, currentPage);
  }, [canMark, fileId, currentPage, markSelectionAsArticle]);

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        disabled={!canMark}
        onClick={handleMark}
        className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground transition-opacity disabled:cursor-default disabled:opacity-40 hover:enabled:opacity-90"
      >
        <Newspaper className="h-3.5 w-3.5" />
        标记为报道
      </button>
    </div>
  );
}
