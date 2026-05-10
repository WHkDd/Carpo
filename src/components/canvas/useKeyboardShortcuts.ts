import { useEffect, useRef, useCallback } from "react";
import { useStore } from "@/store";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

function getActivePage() {
  const s = useStore.getState();
  if (!s.manualDrawMode) return null;
  const fileId = s.currentFileId;
  if (!fileId) return null;
  const file = s.files.find((f) => f.id === fileId);
  if (!file) return null;
  return { fileId, page: file.currentPage ?? 1 };
}

export function useKeyboardShortcuts() {
  const confirmOpenRef = useRef(false);

  const handleDelete = useCallback(() => {
    const ctx = getActivePage();
    if (!ctx) return;
    const { fileId, page } = ctx;
    const s = useStore.getState();
    const order = s.getSelectionOrder(fileId, page);
    if (order.length === 0) return;

    if (order.length > 5) {
      if (confirmOpenRef.current) return;
      confirmOpenRef.current = true;
      const ok = window.confirm(`确定要删除选中的 ${order.length} 个版块吗？`);
      confirmOpenRef.current = false;
      if (!ok) return;
    }

    s.removeBlocks(fileId, page, [...order]);
    s.clearSelection(fileId, page);
  }, []);

  const handleUndoSelection = useCallback(() => {
    const ctx = getActivePage();
    if (!ctx) return;
    const { fileId, page } = ctx;
    useStore.getState().popSelection(fileId, page);
  }, []);

  const handleNudge = useCallback((dx: number, dy: number) => {
    const ctx = getActivePage();
    if (!ctx) return;
    const { fileId, page } = ctx;
    const s = useStore.getState();
    const order = s.getSelectionOrder(fileId, page);
    if (order.length === 0) return;
    for (const id of order) {
      const ps = s.getPageState(fileId, page);
      const block = ps.blocks.find((b) => b.id === id);
      if (!block) continue;
      s.updateBlock(fileId, page, id, { x: block.x + dx, y: block.y + dy });
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;

      // ⌘Z / Ctrl+Z
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndoSelection();
        return;
      }

      // Arrow keys nudge
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        const ctx = getActivePage();
        if (!ctx) return;
        e.preventDefault();
        const step = e.shiftKey ? 8 : 1;
        let dx = 0;
        let dy = 0;
        if (e.key === "ArrowUp") dy = -step;
        if (e.key === "ArrowDown") dy = step;
        if (e.key === "ArrowLeft") dx = -step;
        if (e.key === "ArrowRight") dx = step;
        handleNudge(dx, dy);
        return;
      }

      // Delete / Backspace
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        handleDelete();
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleDelete, handleUndoSelection, handleNudge]);
}
