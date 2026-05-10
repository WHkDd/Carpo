import { useEffect } from "react";
import { useStore } from "@/store";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        const s = useStore.getState();
        if (!s.manualDrawMode) return;
        const fileId = s.currentFileId;
        if (!fileId) return;
        const file = s.files.find((f) => f.id === fileId);
        if (!file) return;
        const page = file.currentPage ?? 1;
        const order = s.getSelectionOrder(fileId, page);
        if (order.length === 0) return;
        e.preventDefault();
        s.removeBlocks(fileId, page, [...order]);
        s.clearSelection(fileId, page);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
