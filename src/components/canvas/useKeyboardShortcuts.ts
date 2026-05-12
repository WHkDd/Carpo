import { useEffect, useCallback } from "react";
import { useStore } from "@/store";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

// Window-level keyboard events fire in browse mode too, so this helper
// must guard `manualDrawMode` itself — unlike the canvas-side getActivePage
// in ImageCanvas, whose call sites are already isolated by BlockRect's
// `listening={interactive}` / useDrawBlock's own guard.
function getActiveDrawCtx() {
  const s = useStore.getState();
  if (s.recognitionMode !== "grouped") return null;
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
    const ctx = getActiveDrawCtx();
    if (!ctx) return;
    const { fileId, page } = ctx;
    const s = useStore.getState();
    const order = s.getSelectionOrder(fileId, page);
    const editingId = s.getEditingBlockId(fileId, page);
    if (order.length === 0 && !editingId) return;
    onDeleteSelected();
  }, [onDeleteSelected]);

  const handleUndoSelection = useCallback(() => {
    const ctx = getActiveDrawCtx();
    if (!ctx) return;
    const { fileId, page } = ctx;
    useStore.getState().popSelection(fileId, page);
  }, []);

  const handleMarkSelectionAsArticle = useCallback(() => {
    const ctx = getActiveDrawCtx();
    if (!ctx) return;
    const { fileId, page } = ctx;
    useStore.getState().markSelectionAsArticle(fileId, page);
  }, []);

  const handleNudge = useCallback((dx: number, dy: number) => {
    const ctx = getActiveDrawCtx();
    if (!ctx) return;
    const { fileId, page } = ctx;
    const s = useStore.getState();
    const order = s.getSelectionOrder(fileId, page);
    const ids = order.length > 0
      ? [...order]
      : (() => {
          const editingId = s.getEditingBlockId(fileId, page);
          return editingId ? [editingId] : [];
        })();
    if (ids.length === 0) return;
    for (const id of ids) {
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
        const ctx = getActiveDrawCtx();
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
