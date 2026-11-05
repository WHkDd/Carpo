// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {  useListKeyboard } from "./useListKeyboard";

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
