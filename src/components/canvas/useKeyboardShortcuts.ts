import { useEffect, useCallback } from "react";
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

export interface UseKeyboardShortcutsArgs {
  onDeleteSelected: () => void;
  enabled?: boolean;
}

export function useKeyboardShortcuts({
  onDeleteSelected,
  enabled = true,
}: UseKeyboardShortcutsArgs) {
  const handleDelete = useCallback(() => {
    const ctx = getActivePage();
    if (!ctx) return;
    const { fileId, page } = ctx;
    const s = useStore.getState();
    const order = s.getSelectionOrder(fileId, page);
    if (order.length === 0) return;
    onDeleteSelected();
  }, [onDeleteSelected]);

  const handleUndoSelection = useCallback(() => {
    const ctx = getActivePage();
    if (!ctx) return;
    const { fileId, page } = ctx;
    useStore.getState().popSelection(fileId, page);
  }, []);

  const handleMarkSelectionAsArticle = useCallback(() => {
    const ctx = getActivePage();
    if (!ctx) return;
    const { fileId, page } = ctx;
    useStore.getState().markSelectionAsArticle(fileId, page);
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
      if (!enabled) return;
      if (isEditableTarget(e.target)) return;

      // ⌘Z / Ctrl+Z
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndoSelection();
        return;
      }

      // ⌘G / Ctrl+G
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g" && !e.shiftKey) {
        e.preventDefault();
        handleMarkSelectionAsArticle();
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
  }, [
    enabled,
    handleDelete,
    handleMarkSelectionAsArticle,
    handleUndoSelection,
    handleNudge,
  ]);
}
