// @vitest-environment jsdom

import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useScrollMemory } from "./useScrollMemory";

/** jsdom does not lay out, so `scrollTop` is a plain writable property here.
 *  That is enough: the hook only ever reads and writes that one value. */
function attach(node: HTMLDivElement, ref: React.RefObject<HTMLDivElement | null>) {
  (ref as { current: HTMLDivElement | null }).current = node;
}

describe("useScrollMemory", () => {
  it("restores a document's offset and opens unseen ones at the top", () => {
    const node = document.createElement("div");
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useScrollMemory<HTMLDivElement>(key),
      { initialProps: { key: "page-1" } }
    );
    attach(node, result.current.ref);

    node.scrollTop = 420;
    act(() => result.current.onScroll());

    // A page never visited before starts at the top, not at 420.
    rerender({ key: "page-2" });
    expect(node.scrollTop).toBe(0);

    node.scrollTop = 90;
    act(() => result.current.onScroll());

    // Back to the first page: its own offset, not the second page's.
    rerender({ key: "page-1" });
    expect(node.scrollTop).toBe(420);

    rerender({ key: "page-2" });
    expect(node.scrollTop).toBe(90);
  });

  it("files a scroll under the document that was on screen when it happened", () => {
    const node = document.createElement("div");
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useScrollMemory<HTMLDivElement>(key),
      { initialProps: { key: "a" } }
    );
    attach(node, result.current.ref);

    // Restoring sets scrollTop, which in a browser fires a scroll event. That
    // event must be attributed to the incoming document, not the outgoing one.
    rerender({ key: "b" });
    node.scrollTop = 200;
    act(() => result.current.onScroll());

    rerender({ key: "a" });
    expect(node.scrollTop).toBe(0);
    rerender({ key: "b" });
    expect(node.scrollTop).toBe(200);
  });
});
