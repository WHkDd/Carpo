// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutPage } from "@/lib/layout-document";
import { LayoutBlockList } from "./LayoutBlockList";

const { state, setEditingLayoutBlock } = vi.hoisted(() => ({
  state: {
    payload: null as { width: number; height: number } | null,
  },
  setEditingLayoutBlock: vi.fn(),
}));

vi.mock("@/store", () => {
  const store = {
    updateLayoutBlockText: vi.fn(),
    setEditingLayoutBlock,
    get files() {
      return [{ id: "file-1", payload: state.payload }];
    },
  };
  return { useStore: (selector: (s: typeof store) => unknown) => selector(store) };
});

/** A 300-DPI Paddle page: two stacked blocks. */
const LAYOUT: LayoutPage = {
  index: 1,
  width: 2362,
  height: 3543,
  blocks: [
    { label: "text", text: "本埠新聞", bbox: [100, 100, 1000, 800], order: 1 },
    { label: "text", text: "巳於昨日", bbox: [100, 900, 1000, 1600], order: 2 },
  ],
};

function renderList(layout: LayoutPage = LAYOUT) {
  return render(<LayoutBlockList fileId="file-1" page={1} layout={layout} />);
}

describe("LayoutBlockList canvas link", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    // Preview bitmap at half the OCR resolution — an isotropic, trustworthy
    // mapping.
    state.payload = { width: 1181, height: 1771 };
  });

  it("publishes the focused block and clears it on blur", () => {
    renderList();
    const second = screen.getByRole("textbox", { name: "版面块 text，第 2 块" });

    fireEvent.focus(second);
    expect(setEditingLayoutBlock).toHaveBeenLastCalledWith("file-1", {
      page: 1,
      index: 1,
    });

    fireEvent.blur(second);
    expect(setEditingLayoutBlock).toHaveBeenLastCalledWith("file-1", null);
  });

  it("clears the highlight on unmount, where no blur fires", () => {
    const { unmount } = renderList();
    fireEvent.focus(screen.getByRole("textbox", { name: "版面块 text，第 1 块" }));
    setEditingLayoutBlock.mockClear();

    unmount();
    expect(setEditingLayoutBlock).toHaveBeenCalledWith("file-1", null);
  });

  it("says nothing about locating blocks when the mapping is sound", () => {
    renderList();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("warns when the page dimensions cannot be trusted", () => {
    // The shape an estimated page size produces: the two axes disagree, so the
    // canvas will refuse to draw and the list has to say why.
    renderList({ ...LAYOUT, width: 2000, height: 3400 });
    expect(screen.getByRole("status").textContent).toBe(
      "该页缺少可靠的版面尺寸信息，无法在画布中定位区块"
    );
  });

  it("stays quiet while the page bitmap is still loading", () => {
    // No payload yet is a transient state, not a broken page — warning here
    // would cry wolf on every page turn.
    state.payload = null;
    renderList();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
