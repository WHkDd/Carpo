// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRowCommandTarget, useListKeyboard } from "./useListKeyboard";

function keyEvent(key: string): React.KeyboardEvent {
  return {
    key,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    preventDefault: vi.fn(),
  } as unknown as React.KeyboardEvent;
}

/** One grid row: a focusable selection cell plus two command buttons, which
 *  is the shape both the queue and the article list render. */
function mountRow(): {
  cell: HTMLElement;
  commands: HTMLButtonElement[];
} {
  document.body.innerHTML = `
    <div role="grid">
      <div role="row">
        <div role="gridcell" tabindex="0" id="cell"></div>
        <div role="gridcell">
          <button type="button" tabindex="-1" id="rename"></button>
          <button type="button" tabindex="-1" id="remove"></button>
        </div>
      </div>
    </div>`;
  return {
    cell: document.getElementById("cell")!,
    commands: [
      document.getElementById("rename") as HTMLButtonElement,
      document.getElementById("remove") as HTMLButtonElement,
    ],
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useListKeyboard", () => {
  it("moves through a list with arrows and Home/End", () => {
    let activeIndex = 1;
    const onSelect = vi.fn((index: number) => {
      activeIndex = index;
    });
    const focusAt = vi.fn();
    const { result, rerender } = renderHook(
      ({ active }: { active: number }) =>
        useListKeyboard({
          itemCount: 3,
          activeIndex: active,
          onSelect,
          labelAt: (index) => ["A", "B", "C"][index]!,
          focusAt,
        }),
      { initialProps: { active: activeIndex } }
    );

    act(() => result.current.onKeyDown(keyEvent("ArrowDown")));
    expect(onSelect).toHaveBeenLastCalledWith(2);
    rerender({ active: activeIndex });

    act(() => result.current.onKeyDown(keyEvent("Home")));
    expect(onSelect).toHaveBeenLastCalledWith(0);
    rerender({ active: activeIndex });

    act(() => result.current.onKeyDown(keyEvent("End")));
    expect(onSelect).toHaveBeenLastCalledWith(2);
    expect(focusAt).toHaveBeenLastCalledWith(2);
  });

  it("cycles repeated letters without corrupting the next prefix", () => {
    vi.useFakeTimers();
    let activeIndex = 0;
    const onSelect = vi.fn((index: number) => {
      activeIndex = index;
    });
    const labels = ["sand", "scene", "snow"];
    const { result, rerender } = renderHook(
      ({ active }: { active: number }) =>
        useListKeyboard({
          itemCount: labels.length,
          activeIndex: active,
          onSelect,
          labelAt: (index) => labels[index]!,
          focusAt: vi.fn(),
        }),
      { initialProps: { active: activeIndex } }
    );

    act(() => result.current.onKeyDown(keyEvent("s")));
    expect(activeIndex).toBe(1);
    rerender({ active: activeIndex });

    act(() => {
      vi.advanceTimersByTime(100);
      result.current.onKeyDown(keyEvent("s"));
    });
    expect(activeIndex).toBe(2);
    rerender({ active: activeIndex });

    act(() => {
      vi.advanceTimersByTime(100);
      result.current.onKeyDown(keyEvent("c"));
    });
    expect(activeIndex).toBe(1);
    vi.useRealTimers();
  });

  it("walks into the row's commands with ArrowRight and back with ArrowLeft", () => {
    const { cell, commands } = mountRow();
    const focusAt = vi.fn(() => cell.focus());
    const { result } = renderHook(() =>
      useListKeyboard({
        itemCount: 1,
        activeIndex: 0,
        onSelect: vi.fn(),
        labelAt: () => "row",
        focusAt,
      })
    );

    cell.focus();
    act(() => result.current.onKeyDown(keyEvent("ArrowRight")));
    expect(document.activeElement).toBe(commands[0]);

    act(() => result.current.onKeyDown(keyEvent("ArrowRight")));
    expect(document.activeElement).toBe(commands[1]);

    // Last command: stay rather than wrap off the end of the row.
    act(() => result.current.onKeyDown(keyEvent("ArrowRight")));
    expect(document.activeElement).toBe(commands[1]);

    act(() => result.current.onKeyDown(keyEvent("ArrowLeft")));
    expect(document.activeElement).toBe(commands[0]);

    act(() => result.current.onKeyDown(keyEvent("ArrowLeft")));
    expect(focusAt).toHaveBeenCalledWith(0);
    expect(document.activeElement).toBe(cell);
  });

  it("leaves ArrowLeft alone when focus is on the selection cell", () => {
    const { cell } = mountRow();
    const { result } = renderHook(() =>
      useListKeyboard({
        itemCount: 1,
        activeIndex: 0,
        onSelect: vi.fn(),
        labelAt: () => "row",
        focusAt: vi.fn(),
      })
    );

    cell.focus();
    const event = keyEvent("ArrowLeft");
    act(() => result.current.onKeyDown(event));
    // The canvas owns ←/→ for page turns; the list must not swallow them
    // when there is nowhere to move inside the row.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(cell);
  });
});

describe("isRowCommandTarget", () => {
  it("distinguishes a row command from the selection cell", () => {
    const { cell, commands } = mountRow();
    expect(isRowCommandTarget(commands[0]!)).toBe(true);
    expect(isRowCommandTarget(cell)).toBe(false);
    expect(isRowCommandTarget(null)).toBe(false);
  });
});
