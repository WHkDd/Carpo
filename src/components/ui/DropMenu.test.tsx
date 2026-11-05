// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeMenuPosition,
  DropMenu,
  type DropMenuEntry,
} from "./DropMenu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Key = "a" | "b" | "c";

function stubRect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    ...overrides,
    toJSON: () => ({}),
  } as DOMRect;
}

function setup(
  items: DropMenuEntry<Key>[],
  props: Partial<React.ComponentProps<typeof DropMenu<Key>>> = {},
  triggerRect?: Partial<DOMRect>
) {
  const onSelect = vi.fn();
  render(
    <DropMenu<Key>
      ariaLabel="示例菜单"
      triggerLabel="触发器"
      items={items}
      onSelect={onSelect}
      {...props}
    />
  );
  const trigger = screen.getByRole("button", {
    name: "示例菜单",
  }) as HTMLButtonElement;
  // jsdom has no layout engine; give the trigger a realistic position near
  // the bottom edge of the viewport so the placement arithmetic has real
  // numbers to flip against.
  trigger.getBoundingClientRect = () =>
    stubRect({
      left: 100,
      right: 180,
      top: 700,
      bottom: 726,
      width: 80,
      height: 26,
      x: 100,
      y: 700,
      ...triggerRect,
    });
  return { onSelect, trigger };
}

const RADIO_ITEMS: DropMenuEntry<Key>[] = [
  { key: "a", label: "甲" },
  { key: "b", label: "乙", selected: true },
  { key: "c", label: "丙" },
];

describe("DropMenu — status bar baseline behaviour", () => {
  it("wraps with the arrow keys and moves the single tab stop", () => {
    const { trigger } = setup(RADIO_ITEMS);
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getAllByRole("menuitemradio")[2]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getAllByRole("menuitemradio")[0]);

    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((it) => it.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
    ]);
  });

  it("stays open when the pointer goes down inside the portal menu", () => {
    // The menu lives at <body> now, not inside the wrapper: an outside-click
    // check that only excludes the wrapper would close the menu on its own
    // items' mousedown and every selection would die.
    const { trigger } = setup(RADIO_ITEMS);
    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByRole("menuitemradio", { name: "丙" }));
    expect(screen.getByRole("menu")).not.toBeNull();
  });
});

describe("DropMenu — disabled entries", () => {
  const withDisabled: DropMenuEntry<Key>[] = [
    { key: "a", label: "甲" },
    { key: "b", label: "乙", disabled: true },
    { key: "c", label: "丙" },
  ];

  it("skips disabled entries with the arrow keys", () => {
    const { trigger } = setup(withDisabled);
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitemradio");

    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("never opens on a disabled entry, even when it is the selected one", () => {
    const { trigger } = setup([
      { key: "a", label: "甲" },
      { key: "b", label: "乙", selected: true, disabled: true },
    ]);
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemradio", { name: "甲" })
    );
  });
});

describe("DropMenu — role dispatch and separators", () => {
  it("skips separators with the arrow keys", () => {
    const { trigger } = setup([
      { key: "a", label: "甲", variant: "action" },
      { separator: true },
      { key: "b", label: "乙", variant: "action" },
    ]);
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "乙" })
    );
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "乙" })
    );
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "甲" })
    );
  });
});

describe("DropMenu — onOpen", () => {
  it("fires once per closed → open transition, on both click and arrow keys", () => {
    const onOpen = vi.fn();
    const { trigger } = setup(RADIO_ITEMS, { onOpen });

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // Re-clicking the trigger closes without firing again.
    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(onOpen).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });
});

describe("computeMenuPosition — pure placement arithmetic", () => {
  const viewport = { width: 1024, height: 768 };

  it("flips to the other side when the preferred side lacks room", () => {
    const pos = computeMenuPosition({
      triggerRect: { left: 400, right: 480, top: 20, bottom: 46 },
      menuSize: { width: 160, height: 200 },
      viewport,
      placement: "top",
      align: "start",
    });
    expect(pos.placement).toBe("bottom");
    expect(pos.top).toBe(54);
    expect(pos.maxHeight).toBe(714);
  });

  it("takes the larger side and caps the height when it fits neither", () => {
    const pos = computeMenuPosition({
      triggerRect: { left: 400, right: 480, top: 300, bottom: 326 },
      menuSize: { width: 160, height: 800 },
      viewport,
      placement: "top",
      align: "start",
    });
    expect(pos.placement).toBe("bottom");
    expect(pos.top).toBe(334);
    expect(pos.maxHeight).toBe(434);
  });

  it("recomputes after the menu grows asynchronously", () => {
    // The model list arrives after open: the small first measure fits above,
    // the grown measure must flip below.
    const trigger = { left: 400, right: 480, top: 300, bottom: 326 };
    const first = computeMenuPosition({
      triggerRect: trigger,
      menuSize: { width: 160, height: 100 },
      viewport,
      placement: "top",
      align: "start",
    });
    expect(first.placement).toBe("top");
    const grown = computeMenuPosition({
      triggerRect: trigger,
      menuSize: { width: 160, height: 400 },
      viewport,
      placement: "top",
      align: "start",
    });
    expect(grown.placement).toBe("bottom");
    expect(grown.top).toBe(334);
  });

  it("clamps a right-edge trigger's start-aligned menu into the viewport", () => {
    const pos = computeMenuPosition({
      triggerRect: { left: 1000, right: 1010, top: 400, bottom: 426 },
      menuSize: { width: 200, height: 100 },
      viewport,
      placement: "top",
      align: "start",
    });
    expect(pos.left).toBe(816);
  });

  it("handles a menu wider than the viewport without panicking", () => {
    const pos = computeMenuPosition({
      triggerRect: { left: 500, right: 580, top: 400, bottom: 426 },
      menuSize: { width: 2000, height: 100 },
      viewport,
      placement: "top",
      align: "start",
    });
    expect(pos.left).toBe(8);
    expect(pos.maxWidth).toBe(360);
  });
});
