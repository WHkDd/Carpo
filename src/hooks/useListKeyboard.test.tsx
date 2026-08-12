// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useListKeyboard } from "./useListKeyboard";

function keyEvent(key: string): React.KeyboardEvent {
  return {
    key,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    preventDefault: vi.fn(),
  } as unknown as React.KeyboardEvent;
}

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
});
