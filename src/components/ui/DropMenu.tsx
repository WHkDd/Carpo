import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A DOM drop-down menu shared by the status bar and the right-rail panel
 * toolbar.
 *
 * Deliberately not a Tauri native popup: the Docker/Web build has to ship the
 * same feature set, and `menu.popup_at()` would mean maintaining a second DOM
 * menu whose behaviour drifts from this one. The cost of that choice is that
 * the material, shadow and radius are drawn in CSS rather than by the OS.
 *
 * The native behaviours this does carry: Escape closes and returns focus to
 * the trigger, arrow keys move a single roving focus rather than making every
 * entry a tab stop, unavailable entries are dimmed and skipped by the keyboard
 * instead of disappearing, and nothing animates.
 *
 * The menu is rendered through a portal at `<body>` with `position: fixed`
 * coordinates measured from the trigger — an ancestor's `overflow: hidden`
 * (the right rail) or a dragged-narrow column must never clip it. Placement
 * is computed by the pure `computeMenuPosition` (flip when the preferred side
 * lacks room, clamp into the viewport, cap the height with an internal
 * scroll area), and re-run on window resize / scroll and on the menu's own
 * size changes — the proofread model list arrives asynchronously after open,
 * and only a `ResizeObserver` sees that.
 */

export type DropMenuPlacement = "top" | "bottom";

/** Horizontal anchoring of the menu against the trigger. Right-aligned
 *  toolbars (the right rail) pass `"end"` so the panel opens inwards. */
export type DropMenuAlign = "start" | "end";

/**
 * `radio` renders `menuitemradio` + `aria-checked` — for menus that pick one
 * of a set (provider, OCR profile, proofread model). `action` renders a plain
 * `menuitem`; using `radio` for action entries makes VoiceOver announce them
 * as a radio group, which is a lie about what they do.
 */
export type DropMenuItemVariant = "radio" | "action";

export interface DropMenuItem<T extends string> {
  key: T;
  label: string;
  selected?: boolean;
  hint?: string;
  /** Dimmed and skipped by arrow-key navigation, but still occupies its slot. */
  disabled?: boolean;
  /** Defaults to `radio`. */
  variant?: DropMenuItemVariant;
}

export interface DropMenuSeparator {
  separator: true;
}

export type DropMenuEntry<T extends string> =
  | DropMenuItem<T>
  | DropMenuSeparator;

export interface DropMenuProps<T extends string> {
  ariaLabel: string;
  /** Omit for an icon-only trigger; `ariaLabel` then carries the name. */
  triggerLabel?: string;
  triggerHint?: string;
  triggerClassName?: string;
  /** Rendered before the label — lets the panel toolbar use an icon trigger. */
  triggerIcon?: ReactNode;
  /** Whole menu unavailable, e.g. when every entry would be disabled. */
  disabled?: boolean;
  /**
   * Which way the panel opens. Defaults to `top` because the status bar sits
   * at the bottom edge of the window; toolbars near the top pass `bottom`.
   */
  placement?: DropMenuPlacement;
  /**
   * Horizontal anchoring. Defaults to `start`; right-edge toolbars pass
   * `"end"` so the panel grows inwards instead of running off the viewport.
   */
  align?: DropMenuAlign;
  /** Fired each time the menu transitions closed → open. Lets a caller load
   *  expensive entry data lazily (the proofread model list is a network
   *  call) instead of paying for it on mount. */
  onOpen?: () => void;
  items: DropMenuEntry<T>[];
  onSelect: (key: T) => void;
}

/** Minimum distance kept between the menu and the viewport edges. */
export const MENU_VIEWPORT_MARGIN = 8;
/** Gap between the trigger and the panel. */
export const MENU_TRIGGER_GAP = 8;
/** Cap on the panel's width — a long model id must truncate, not push the
 *  menu off the screen. */
export const MENU_MAX_WIDTH = 360;

export interface ComputeMenuPositionArgs {
  triggerRect: { left: number; right: number; top: number; bottom: number };
  menuSize: { width: number; height: number };
  viewport: { width: number; height: number };
  placement: DropMenuPlacement;
  align: DropMenuAlign;
}

export interface ComputeMenuPositionResult {
  left: number;
  top: number;
  /** The menu's height is capped to the room on the chosen side; the menu
   *  node scrolls (`overflow-y: auto`) inside it. */
  maxHeight: number;
  /** Width cap: long labels truncate instead of overflowing the viewport. */
  maxWidth: number;
  /** The side actually used — may differ from the request when the preferred
   *  side lacks room. */
  placement: DropMenuPlacement;
}

/**
 * Pure placement arithmetic for a portal menu. Kept free of DOM reads so it
 * can be tested table-driven (jsdom has no layout engine — this function is
 * where the flip / clamp / cap rules actually get verified).
 *
 * Rules: open on the requested side; flip to the other side when the menu
 * does not fit there but does on the other; when it fits neither, take the
 * side with more room and cap the height (the menu scrolls). Horizontally,
 * the panel is anchored to the trigger's `start` or `end` edge and clamped
 * into `[margin, viewport - width - margin]`.
 */
export function computeMenuPosition({
  triggerRect,
  menuSize,
  viewport,
  placement,
  align,
}: ComputeMenuPositionArgs): ComputeMenuPositionResult {
  const margin = MENU_VIEWPORT_MARGIN;
  const availableAbove = triggerRect.top - margin;
  const availableBelow = viewport.height - triggerRect.bottom - margin;
  const fits = (side: DropMenuPlacement): boolean =>
    menuSize.height <= (side === "top" ? availableAbove : availableBelow);

  let effective: DropMenuPlacement = placement;
  if (!fits(placement)) {
    const other: DropMenuPlacement = placement === "top" ? "bottom" : "top";
    if (fits(other)) {
      effective = other;
    } else {
      effective = availableBelow >= availableAbove ? "bottom" : "top";
    }
  }

  let top: number;
  let maxHeight: number;
  if (effective === "top") {
    if (fits("top")) {
      top = triggerRect.top - MENU_TRIGGER_GAP - menuSize.height;
      maxHeight = availableAbove;
    } else {
      // Capped: fill everything above the trigger, down to the margin.
      top = margin;
      maxHeight = Math.max(0, availableAbove);
    }
  } else {
    top = triggerRect.bottom + MENU_TRIGGER_GAP;
    maxHeight = Math.max(0, availableBelow);
  }

  const menuLeft =
    align === "end" ? triggerRect.right - menuSize.width : triggerRect.left;
  const maxLeft = Math.max(margin, viewport.width - menuSize.width - margin);
  const left = Math.min(Math.max(menuLeft, margin), maxLeft);
  const maxWidth = Math.min(
    Math.max(0, viewport.width - 2 * margin),
    MENU_MAX_WIDTH
  );
  return { left, top, maxHeight, maxWidth, placement: effective };
}

function isSeparator<T extends string>(
  entry: DropMenuEntry<T>
): entry is DropMenuSeparator {
  return "separator" in entry;
}

/** Separators and disabled entries are rendered but never focused. */
function isFocusable<T extends string>(entry: DropMenuEntry<T>): boolean {
  return !isSeparator(entry) && entry.disabled !== true;
}

export function DropMenu<T extends string>({
  ariaLabel,
  triggerLabel,
  triggerHint,
  triggerClassName = "",
  triggerIcon,
  disabled = false,
  placement = "top",
  align = "start",
  onOpen,
  items,
  onSelect,
}: DropMenuProps<T>) {
  const [open, setOpen] = useState(false);
  // Roving focus index into `items`. A native menu moves a single focused
  // item with the arrow keys rather than making every entry a tab stop.
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    top: number;
    maxHeight: number;
    maxWidth: number;
    placement: DropMenuPlacement;
  } | null>(null);
  const lastPositionRef = useRef<string>("");

  const focusableIndexes = items.reduce<number[]>((acc, entry, index) => {
    if (isFocusable(entry)) acc.push(index);
    return acc;
  }, []);
  const hasFocusable = focusableIndexes.length > 0;
  const firstFocusable = focusableIndexes.at(0);
  const lastFocusable = focusableIndexes.at(-1);

  const step = (from: number, delta: number): number => {
    if (firstFocusable === undefined || lastFocusable === undefined) return from;
    const at = focusableIndexes.indexOf(from);
    // An unfocusable starting point (stale index after the item list changed)
    // falls back to the first entry in the travel direction.
    if (at === -1) return delta > 0 ? firstFocusable : lastFocusable;
    const next =
      (at + delta + focusableIndexes.length) % focusableIndexes.length;
    return focusableIndexes[next] ?? from;
  };

  const openAt = (index: number | undefined) => {
    if (index === undefined) return;
    setActiveIndex(index);
    setOpen(true);
  };

  // Closed → open transition; both the click path and the arrow-key path go
  // through here so `onOpen` fires exactly once per open.
  const openMenu = (index: number | undefined) => {
    if (!open) onOpen?.();
    openAt(index);
  };

  // Returning focus to the trigger is what makes Escape and select feel like
  // a menu instead of a popover: focus never falls back to <body>.
  const closeAndRestore = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Measure the freshly committed menu and place it before the browser
  // paints. `offsetWidth` / `offsetHeight` are readable synchronously in a
  // layout effect, so there is no hidden first frame — and no hidden frame
  // means the focus call in the next effect lands on a visible node (focusing
  // a `visibility: hidden` element is a no-op, which silently kills the
  // roving focus). The position is recomputed when the window moves or the
  // menu's *content* grows: the proofread model list arrives after open, and
  // neither `resize` nor `scroll` fires for a content-size change — only a
  // `ResizeObserver` on the menu node catches that.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const node = menuRef.current;
    if (!trigger || !node) return;
    const update = () => {
      const triggerRect = trigger.getBoundingClientRect();
      const pos = computeMenuPosition({
        triggerRect: {
          left: triggerRect.left,
          right: triggerRect.right,
          top: triggerRect.top,
          bottom: triggerRect.bottom,
        },
        menuSize: { width: node.offsetWidth, height: node.offsetHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        placement,
        align,
      });
      const key = `${pos.left},${pos.top},${pos.maxHeight},${pos.maxWidth},${pos.placement}`;
      if (key !== lastPositionRef.current) {
        lastPositionRef.current = key;
        setMenuPosition(pos);
      }
    };
    update();
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(node);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { capture: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, { capture: true });
    };
  }, [open, placement, align]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The menu is portaled to <body>, so it is no longer a descendant of
      // `wrapRef` — excluding only the wrapper would close the menu on its
      // own items' mousedown, and every click inside the menu would die
      // before `onSelect` ever fires.
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // A menu whose entries all became unavailable while it was open would trap
  // focus on nothing; close it rather than leave an empty panel behind.
  useEffect(() => {
    if (open && !hasFocusable) setOpen(false);
  }, [open, hasFocusable]);

  const selectedIndex = (() => {
    const found = items.findIndex(
      (entry) => isFocusable(entry) && !isSeparator(entry) && entry.selected
    );
    return found === -1 ? firstFocusable : found;
  })();

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeAndRestore();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => step(i, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => step(i, -1));
    } else if (e.key === "Home") {
      e.preventDefault();
      if (firstFocusable !== undefined) setActiveIndex(firstFocusable);
    } else if (e.key === "End") {
      e.preventDefault();
      if (lastFocusable !== undefined) setActiveIndex(lastFocusable);
    } else if (e.key === "Tab") {
      // Tab out of an open menu closes it, matching platform menus. Focus
      // goes back to the trigger and the browser's default Tab then moves
      // on from there — the portal node sits at the end of <body>, so
      // tabbing onward from the menu itself would land nowhere near the
      // trigger.
      closeAndRestore();
    }
  };

  const triggerDisabled = disabled || !hasFocusable;

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        // An icon-only trigger has no visible name, so it needs the platform
        // tooltip its neighbours in a toolbar get. A labelled trigger already
        // reads its own name and a tooltip repeating it would be noise.
        title={triggerLabel === undefined ? ariaLabel : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={triggerDisabled}
        onClick={() => (open ? setOpen(false) : openMenu(selectedIndex))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openMenu(e.key === "ArrowDown" ? firstFocusable : lastFocusable);
          }
        }}
        className={cn(
          "flex h-6 items-center gap-0.5 rounded px-1 transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40",
          triggerClassName
        )}
      >
        {triggerIcon}
        {triggerLabel !== undefined && <span>{triggerLabel}</span>}
        {triggerHint && (
          <span className="ml-1 rounded bg-destructive/10 px-1 py-0.5 text-[10px] font-normal text-destructive">
            {triggerHint}
          </span>
        )}
        <ChevronDown
          className="h-3 w-3 text-foreground-subtle"
          strokeWidth={1.8}
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={ariaLabel}
            onKeyDown={onMenuKeyDown}
            data-placement={menuPosition?.placement ?? placement}
            data-align={align}
            style={
              menuPosition
                ? {
                    position: "fixed",
                    left: menuPosition.left,
                    top: menuPosition.top,
                    maxHeight: menuPosition.maxHeight,
                    maxWidth: menuPosition.maxWidth,
                    visibility: "visible",
                  }
                : {
                    // One commit before the layout effect measures; hidden
                    // rather than parked at a wrong coordinate.
                    position: "fixed",
                    left: 0,
                    top: 0,
                    visibility: "hidden",
                  }
            }
            className="z-50 min-w-[160px] overflow-y-auto rounded-md border border-border/70 bg-background p-1 shadow-md"
          >
            {items.map((entry, index) => {
              if (isSeparator(entry)) {
                return (
                  <div
                    key={`separator-${index}`}
                    role="separator"
                    className="my-1 h-px bg-border/70"
                  />
                );
              }
              const itemDisabled = entry.disabled === true;
              const isRadio = (entry.variant ?? "radio") === "radio";
              return (
                <button
                  key={entry.key}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  role={isRadio ? "menuitemradio" : "menuitem"}
                  aria-checked={isRadio ? entry.selected === true : undefined}
                  disabled={itemDisabled}
                  tabIndex={index === activeIndex ? 0 : -1}
                  onClick={() => {
                    onSelect(entry.key);
                    closeAndRestore();
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-left text-[12px] text-foreground transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    entry.selected && "bg-surface-2",
                    // Dimmed but still present, and it keeps its slot so the
                    // pointer target of the entries around it never moves.
                    itemDisabled &&
                      "pointer-events-none text-foreground-subtle opacity-50"
                  )}
                >
                  <span
                    // Model ids can be long; truncate instead of pushing the
                    // panel off the viewport — the full id stays reachable
                    // through the native tooltip.
                    title={entry.label}
                    className={cn(
                      "min-w-0 truncate",
                      entry.selected && "font-medium"
                    )}
                  >
                    {entry.label}
                  </span>
                  {entry.hint && (
                    <span className="shrink-0 text-[10px] text-foreground-subtle">
                      {entry.hint}
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}
