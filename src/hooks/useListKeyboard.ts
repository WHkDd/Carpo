import { useCallback, useRef } from "react";

/** How long consecutive keystrokes are treated as one type-ahead prefix.
 *  500ms is the platform convention on both macOS and Windows. */
const TYPE_AHEAD_WINDOW_MS = 500;

export interface UseListKeyboardArgs {
  /** Number of rows currently rendered. */
  itemCount: number;
  /** Index of the selected row, or -1 when nothing is selected. */
  activeIndex: number;
  /** Move the selection. Called with an in-range index. */
  onSelect: (index: number) => void;
  /** Text matched by type-ahead — file name, article title. */
  labelAt: (index: number) => string;
  /** Give the row DOM focus. Called after `onSelect` so the roving tabindex
   *  and the focus ring stay on the same row. */
  focusAt: (index: number) => void;
}

/**
 * The keyboard model of a native list (Finder sidebar, Mail message list),
 * not of a web form.
 *
 * The distinction that matters: a native list is a *single* tab stop. You Tab
 * into it once, then arrow through the rows. Rendering each row as its own
 * focusable button — which is what this app did — means a 30-file queue costs
 * 30 Tab presses to cross, which is worse than having no keyboard support at
 * all and is an unmistakable "this is a web page" signal.
 *
 * Selection follows focus here, as it does in the platform lists above: ↑/↓
 * both move and select, so there is no separate "commit" step.
 */
export function useListKeyboard({
  itemCount,
  activeIndex,
  onSelect,
  labelAt,
  focusAt,
}: UseListKeyboardArgs) {
  const bufferRef = useRef("");
  const lastKeyTimeRef = useRef(0);

  const go = useCallback(
    (index: number) => {
      if (index < 0 || index >= itemCount) return;
      onSelect(index);
      focusAt(index);
    },
    [focusAt, itemCount, onSelect]
  );

  const typeAhead = useCallback(
    (char: string) => {
      const now = Date.now();
      // Outside the window the buffer restarts; inside it the character
      // extends the prefix. Repeating one character is the exception —
      // pressing "s" three times should visit successive s-items rather than
      // search for "sss", which is how the platform behaves.
      const continued = now - lastKeyTimeRef.current < TYPE_AHEAD_WINDOW_MS;
      lastKeyTimeRef.current = now;
      const prev = continued ? bufferRef.current : "";
      const repeatSameChar = prev.length > 0 && prev.split("").every((c) => c === char);
      const prefix = repeatSameChar ? char : prev + char;
      // Keep the semantic prefix rather than the raw repeated keystrokes.
      // Otherwise `s`, `s`, `c` would search for "ssc" instead of "sc".
      bufferRef.current = prefix;

      const start = activeIndex < 0 ? 0 : activeIndex;
      // Start one past the current row so a repeated prefix advances instead
      // of re-matching the row already selected.
      const offset = prefix.length === 1 || repeatSameChar ? 1 : 0;
      for (let step = 0; step < itemCount; step += 1) {
        const index = (start + offset + step) % itemCount;
        if (labelAt(index).toLowerCase().startsWith(prefix.toLowerCase())) {
          go(index);
          return;
        }
      }
    },
    [activeIndex, go, itemCount, labelAt]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (itemCount === 0) return;
      if (e.altKey || e.metaKey || e.ctrlKey) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          go(activeIndex < 0 ? 0 : Math.min(itemCount - 1, activeIndex + 1));
          return;
        case "ArrowUp":
          e.preventDefault();
          go(activeIndex < 0 ? itemCount - 1 : Math.max(0, activeIndex - 1));
          return;
        case "Home":
          e.preventDefault();
          go(0);
          return;
        case "End":
          e.preventDefault();
          go(itemCount - 1);
          return;
        default:
          break;
      }

      // Printable single characters drive type-ahead. `e.key.length === 1`
      // excludes every named key ("Enter", "Tab", "F5", …) without an
      // allow-list; a space would scroll, so it is left alone.
      if (e.key.length === 1 && e.key !== " ") {
        e.preventDefault();
        typeAhead(e.key);
      }
    },
    [activeIndex, go, itemCount, typeAhead]
  );

  return { onKeyDown };
}
