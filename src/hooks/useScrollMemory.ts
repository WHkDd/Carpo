import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Per-document scroll memory for a panel whose content is swapped in place.
 *
 * A panel that re-renders with new content but keeps the same DOM node also
 * keeps its old `scrollTop`. Turning a page then leaves the reader parked at
 * wherever the *previous* page's text happened to reach — or, if the new page
 * is shorter, in blank space below it. Native document panes do neither: a
 * document you have not seen opens at the top, and one you are returning to
 * opens where you left it.
 *
 * Positions are kept in a ref, not in the store: they are view state that
 * should die with the panel, and writing one per scroll event through the
 * store would re-render the panel on every frame of a scroll.
 *
 * @param key identifies the document being shown — file, page, article, view
 *            mode. Changing it saves nothing (the scroll handler already
 *            did) and restores the incoming document's position.
 */
export function useScrollMemory<T extends HTMLElement>(key: string) {
  const positions = useRef(new Map<string, number>());
  const ref = useRef<T | null>(null);
  const keyRef = useRef(key);

  const onScroll = useCallback(() => {
    const node = ref.current;
    if (node) positions.current.set(keyRef.current, node.scrollTop);
  }, []);

  // Layout effect, not effect: restoring after paint would show one frame at
  // the wrong offset, which reads as a jump rather than as a restore.
  useLayoutEffect(() => {
    keyRef.current = key;
    const node = ref.current;
    if (node) node.scrollTop = positions.current.get(key) ?? 0;
  }, [key]);

  return { ref, onScroll };
}
