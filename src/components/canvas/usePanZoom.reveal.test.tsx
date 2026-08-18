// @vitest-environment jsdom
//
// `revealRect`'s wiring, as opposed to the geometry maths covered by the pure
// functions in `usePanZoom.test.ts`. The hook is testable here because it only
// touches the store — Konva never enters, which is why `ImageCanvas` itself has
// no test carrier.

import { useEffect } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "@/store";
import { usePanZoom, type UsePanZoomArgs } from "./usePanZoom";

// A 2000×3000 page. Fit into 800×600 is height-limited: 600/3000 × 0.94 =
// 0.188 → 19%, so the page draws 380×570 and is centred.
const PAGE = { imageWidth: 2000, imageHeight: 3000 };
const FIT_AT_800x600 = { zoomPercent: 19, panX: 210, panY: 15, isFit: true };
const FIT_AT_500x600 = { zoomPercent: 19, panX: 60, panY: 15, isFit: true };

// Bottom-right corner of the page, well outside the viewport at 100% zoom.
const FAR_BLOCK = { x: 1500, y: 100, w: 400, h: 200 };

function args(overrides: Partial<UsePanZoomArgs> = {}): UsePanZoomArgs {
  return {
    fileId: "f1",
    currentPage: 1,
    containerWidth: 800,
    containerHeight: 600,
    ...PAGE,
    ...overrides,
  };
}

function view() {
  return useStore.getState().fileViews["f1"];
}

beforeEach(() => {
  useStore.setState({ fileViews: {} });
});

afterEach(() => {
  cleanup();
});

describe("revealRect", () => {
  it("leaves the view alone when the block is already fully visible", () => {
    const { result } = renderHook(() => usePanZoom(args()));
    expect(view()).toEqual(FIT_AT_800x600);

    // At fit the whole page is on screen, so every block within it is visible.
    act(() => result.current.controller.revealRect(1500, 100, 400, 200));
    expect(view()).toEqual(FIT_AT_800x600);
  });

  it("centres an off-screen block, keeping the zoom and dropping fit", () => {
    // A stored view with isFit=false keeps the fit driver out of the way.
    useStore.setState({
      fileViews: { f1: { zoomPercent: 100, panX: 0, panY: 0, isFit: false } },
    });
    const { result } = renderHook(() => usePanZoom(args()));

    act(() =>
      result.current.controller.revealRect(
        FAR_BLOCK.x,
        FAR_BLOCK.y,
        FAR_BLOCK.w,
        FAR_BLOCK.h
      )
    );
    expect(view()).toEqual({
      zoomPercent: 100, // untouched — auto-zoom would cost the user their bearings
      panX: 400 - 1700,
      panY: 300 - 200,
      isFit: false,
    });
  });

  it("is idempotent — a centred block is not re-centred", () => {
    useStore.setState({
      fileViews: { f1: { zoomPercent: 100, panX: 0, panY: 0, isFit: false } },
    });
    const { result } = renderHook(() => usePanZoom(args()));
    const reveal = () =>
      act(() =>
        result.current.controller.revealRect(
          FAR_BLOCK.x,
          FAR_BLOCK.y,
          FAR_BLOCK.w,
          FAR_BLOCK.h
        )
      );

    reveal();
    const afterFirst = { ...view()! };
    reveal();
    expect(view()).toEqual(afterFirst);
  });

  it("keeps re-centring stable for a block taller than the viewport", () => {
    // A newspaper column at reading zoom can never be "fully visible", so this
    // path always centres. It must still settle rather than drift.
    useStore.setState({
      fileViews: { f1: { zoomPercent: 100, panX: 0, panY: 0, isFit: false } },
    });
    const { result } = renderHook(() => usePanZoom(args()));
    const reveal = () =>
      act(() => result.current.controller.revealRect(100, 0, 300, 2400));

    reveal();
    const afterFirst = { ...view()! };
    reveal();
    expect(view()).toEqual(afterFirst);
    expect(afterFirst.panY).toBe(300 - 1200);
  });

  it("does nothing before the container has been measured", () => {
    const { result } = renderHook(() =>
      usePanZoom(args({ containerWidth: 0, containerHeight: 0 }))
    );
    act(() => result.current.controller.revealRect(1500, 100, 400, 200));
    expect(view()).toBeUndefined();
  });
});

describe("revealRect against a fit written in the same effect flush", () => {
  // Mirrors ImageCanvas: usePanZoom runs first, so its fit-driver effect is
  // registered — and therefore flushes — before the reveal effect below.
  function useHarness(
    containerWidth: number,
    reveal: { x: number; y: number; w: number; h: number } | null
  ) {
    const { controller } = usePanZoom(args({ containerWidth }));
    useEffect(() => {
      if (!reveal) return;
      controller.revealRect(reveal.x, reveal.y, reveal.w, reveal.h);
    }, [reveal, controller]);
  }

  it("re-fits without being dragged off by the pre-resize transform", () => {
    const { rerender } = renderHook(
      ({
        containerWidth,
        reveal,
      }: {
        containerWidth: number;
        reveal: typeof FAR_BLOCK | null;
      }) => useHarness(containerWidth, reveal),
      {
        initialProps: {
          containerWidth: 800,
          reveal: null as typeof FAR_BLOCK | null,
        },
      }
    );
    expect(view()).toEqual(FIT_AT_800x600);

    // A block takes focus. It is inside the fitted page, so nothing moves.
    rerender({ containerWidth: 800, reveal: FAR_BLOCK });
    expect(view()).toEqual(FIT_AT_800x600);

    // The rail divider is dragged, shrinking the canvas. The textarea keeps
    // focus (the handle calls preventDefault on pointerdown), so the reveal
    // effect re-runs in the same flush as the fit driver. Reading the stale
    // render-time transform here used to centre against a viewport that no
    // longer existed and silently turn fit off.
    rerender({ containerWidth: 500, reveal: FAR_BLOCK });
    expect(view()).toEqual(FIT_AT_500x600);
  });
});
