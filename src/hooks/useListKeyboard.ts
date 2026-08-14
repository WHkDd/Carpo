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

/** The focusable commands in the row that currently holds focus — the rename
 *  and remove buttons, each in its own `gridcell`. Read from the DOM rather
 *  than from refs because the caller already owns one ref array per row and a
 *  second, ragged one per row would have to be rebuilt on every render. */
function rowCommands(from: Element | null): HTMLElement[] {
  const row = from?.closest('[role="row"]');
  if (!row) return [];
  return Array.from(
    row.querySelectorAll<HTMLElement>('[role="gridcell"] button:not([disabled])')
  );
}

/** True when the event came from a row command rather than from the row's
 *  own selection cell. Callers use it to keep row-level bindings (Enter to
 *  rename, Delete to remove) from firing on top of a button's own activation. */
export function isRowCommandTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('[role="gridcell"] button') !== null
  );
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
 *
 * The container is a `grid`, not a `listbox`, because these rows carry inline
 * commands. ARIA lets a listbox own only `option` elements, so the hover
 * buttons sat inside the listbox as children it is not allowed to have, and
 * no arrow key reached them. A layout grid owns rows of cells and may put
 * widgets in those cells — which is also how AppKit exposes a table row
 * (AXRow with AXCell children). →/← move between the selection cell and the
 * row's commands.
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
        case "ArrowRight": {
          const active = document.activeElement;
          const commands = rowCommands(active);
          if (commands.length === 0) return;
          e.preventDefault();
          const at = commands.findIndex((c) => c === active);
          // From the selection cell (`at === -1`) step onto the first
          // command; from the last one, stay put rather than wrapping.
          (commands[at + 1] ?? commands[at])?.focus();
          return;
        }
        case "ArrowLeft": {
          const active = document.activeElement;
          const at = rowCommands(active).findIndex((c) => c === active);
          if (at < 0) return; // already on the selection cell
          e.preventDefault();
          if (at === 0) focusAt(activeIndex < 0 ? 0 : activeIndex);
          else rowCommands(active)[at - 1]?.focus();
          return;
        }
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
    [activeIndex, focusAt, go, itemCount, typeAhead]
  );

  return { onKeyDown };
}
