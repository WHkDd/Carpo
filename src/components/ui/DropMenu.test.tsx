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
  it("opens on the selected item and reports it as checked", () => {
    const { trigger } = setup(RADIO_ITEMS);
    fireEvent.click(trigger);

    const items = screen.getAllByRole("menuitemradio");
    expect(items).toHaveLength(3);
    expect(items.map((it) => it.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(document.activeElement).toBe(items[1]);
  });

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

  it("selects, closes, and returns focus to the trigger", () => {
    const { trigger, onSelect } = setup(RADIO_ITEMS);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "丙" }));

    expect(onSelect).toHaveBeenCalledWith("c");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape without selecting, and restores focus", () => {
    const { trigger, onSelect } = setup(RADIO_ITEMS);
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Tab and hands focus back to the trigger", () => {
    // The default Tab action then moves on from the trigger; jsdom has no
    // sequential focus navigation, so the restore itself is the assertion.
    const { trigger } = setup(RADIO_ITEMS);
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("opens from the trigger with the arrow keys", () => {
    const { trigger } = setup(RADIO_ITEMS);
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getAllByRole("menuitemradio")[2]);
  });

  it("closes when the pointer goes down outside", () => {
    const { trigger } = setup(RADIO_ITEMS);
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens upwards by default and downwards on request", () => {
    const { trigger } = setup(RADIO_ITEMS);
    fireEvent.click(trigger);
    expect(screen.getByRole("menu").getAttribute("data-placement")).toBe("top");
    expect(screen.getByRole("menu").getAttribute("data-align")).toBe("start");

    cleanup();
    const below = setup(RADIO_ITEMS, { placement: "bottom" });
    fireEvent.click(below.trigger);
    expect(screen.getByRole("menu").getAttribute("data-placement")).toBe(
      "bottom"
    );
  });

  it("flips to the other side when the preferred side lacks room", () => {
    // Trigger at the top edge and a menu taller than the room above it: the
    // panel must open downwards instead of running off the viewport.
    const { trigger } = setup(RADIO_ITEMS, {}, { top: 10, bottom: 36 });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800);
    fireEvent.click(trigger);
    expect(screen.getByRole("menu").getAttribute("data-placement")).toBe(
      "bottom"
    );
  });

  it("reports the horizontal anchoring", () => {
    const { trigger } = setup(RADIO_ITEMS, { align: "end" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu").getAttribute("data-align")).toBe("end");
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

  it("tooltips item labels so a truncated model id stays readable", () => {
    const { trigger } = setup([
      {
        key: "a",
        label: "openrouter/google/gemini-2.5-flash-preview-8b",
        variant: "radio",
      },
    ]);
    fireEvent.click(trigger);
    expect(
      screen.getByText("openrouter/google/gemini-2.5-flash-preview-8b").title
    ).toBe("openrouter/google/gemini-2.5-flash-preview-8b");
  });
});

describe("DropMenu — disabled entries", () => {
  const withDisabled: DropMenuEntry<Key>[] = [
    { key: "a", label: "甲" },
    { key: "b", label: "乙", disabled: true },
    { key: "c", label: "丙" },
  ];

  it("renders a disabled entry instead of hiding it", () => {
    const { trigger } = setup(withDisabled);
    fireEvent.click(trigger);
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    const dimmed = screen.getByRole("menuitemradio", { name: "乙" });
    expect((dimmed as HTMLButtonElement).disabled).toBe(true);
  });

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

  it("disables the trigger when every entry is unavailable", () => {
    const { trigger } = setup([
      { key: "a", label: "甲", disabled: true },
      { key: "b", label: "乙", disabled: true },
    ]);
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("honours an explicitly disabled trigger", () => {
    const { trigger } = setup(RADIO_ITEMS, { disabled: true });
    expect(trigger.disabled).toBe(true);
  });
});

describe("DropMenu — icon-only trigger", () => {
  it("tooltips an icon-only trigger with its accessible name", () => {
    const { trigger } = setup(RADIO_ITEMS, { triggerLabel: undefined });
    expect(trigger.textContent).toBe("");
    expect(trigger.title).toBe("示例菜单");
  });

  it("leaves a labelled trigger without a redundant tooltip", () => {
    const { trigger } = setup(RADIO_ITEMS);
    expect(trigger.title).toBe("");
  });
});

describe("DropMenu — role dispatch and separators", () => {
  it("renders action entries as plain menu items without a checked state", () => {
    const { trigger } = setup([
      { key: "a", label: "导出本页", variant: "action" },
      { key: "b", label: "导出所有页", variant: "action" },
    ]);
    fireEvent.click(trigger);

    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(items.map((it) => it.hasAttribute("aria-checked"))).toEqual([
      false,
      false,
    ]);
  });

  it("mixes action and radio entries across a separator", () => {
    const { trigger } = setup([
      { key: "a", label: "校对全部报道", variant: "action" },
      { separator: true },
      { key: "b", label: "OpenRouter · claude", variant: "radio", selected: true },
      { key: "c", label: "OpenAI · gpt", variant: "radio" },
    ]);
    fireEvent.click(trigger);

    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
    expect(screen.getByRole("separator")).toBeTruthy();
  });

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

  it("opens on the requested side when there is room", () => {
    const trigger = { left: 400, right: 480, top: 400, bottom: 426 };
    const above = computeMenuPosition({
      triggerRect: trigger,
      menuSize: { width: 160, height: 200 },
      viewport,
      placement: "top",
      align: "start",
    });
    expect(above).toEqual({
      left: 400,
      top: 192,
      maxHeight: 392,
      maxWidth: 360,
      placement: "top",
    });
    const below = computeMenuPosition({
      triggerRect: trigger,
      menuSize: { width: 160, height: 200 },
      viewport,
      placement: "bottom",
      align: "start",
    });
    expect(below.top).toBe(434);
    expect(below.maxHeight).toBe(334);
    expect(below.placement).toBe("bottom");
  });

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

  it("clamps a left-edge trigger's end-aligned menu into the viewport", () => {
    const pos = computeMenuPosition({
      triggerRect: { left: 4, right: 84, top: 400, bottom: 426 },
      menuSize: { width: 200, height: 100 },
      viewport,
      placement: "top",
      align: "end",
    });
    expect(pos.left).toBe(8);
  });

  it("anchors an end-aligned menu to the trigger's right edge when it fits", () => {
    const pos = computeMenuPosition({
      triggerRect: { left: 800, right: 880, top: 400, bottom: 426 },
      menuSize: { width: 200, height: 100 },
      viewport,
      placement: "bottom",
      align: "end",
    });
    expect(pos.left).toBe(680);
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
