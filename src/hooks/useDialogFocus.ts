import { useEffect, type RefObject } from "react";

/** Everything the platform considers focusable, minus anything explicitly
 *  removed from the tab order. `[tabindex="-1"]` is intentionally excluded:
 *  those are programmatic focus targets (list rows), not tab stops. */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

/**
 * Gives a modal dialog the three focus behaviours a native sheet has:
 * focus moves inside when it opens, Tab cannot escape while it is open, and
 * focus returns to whatever opened it on close.
 *
 * Without the last one in particular, dismissing a dialog drops focus onto
 * `<body>` — the next Tab press starts over from the top of the window, which
 * is the single most obvious way a webview UI announces it isn't native.
 *
 * @param open       whether the dialog is currently mounted and visible
 * @param ref        the dialog's outermost element
 * @param initialRef optional control to focus first; defaults to the first
 *                   focusable descendant
 */
export function useDialogFocus(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  initialRef?: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;

    // Captured before we move focus, so it is the element the user was on.
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const target = initialRef?.current ?? focusableWithin(root)[0] ?? root;
    // `preventScroll` keeps a long settings pane from jumping to whichever
    // control happens to come first in the DOM.
    target.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusableWithin(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Only restore if focus is still somewhere we put it; if the user has
      // already clicked elsewhere, yanking it back would be the rude option.
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [open, ref, initialRef]);
}
