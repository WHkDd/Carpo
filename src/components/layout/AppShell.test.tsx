// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/components/canvas/ImageCanvas", () => ({ ImageCanvas: () => null }));
import { QueueSidebarFrame } from "./AppShell";
import { SidebarToggle } from "./Toolbar";
import { ProgressPill } from "./ProgressPill";
import { useStore } from "@/store";
import { QUEUE_COLLAPSED_WIDTH } from "@/store/uiSlice";
const INITIAL = useStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  useStore.setState(INITIAL, true);
  useStore.getState().setQueueCollapsed(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const frame = () => screen.getByTestId("queue-panel-frame");
const enter = () => fireEvent.mouseEnter(screen.getByTestId("queue-peek-edge"));
const leave = () => {
  fireEvent.mouseLeave(screen.getByTestId("queue-peek-edge"));
  fireEvent.mouseLeave(frame());
};

describe("queue edge reveal", () => {
  it("uses one top control and reports the overlay visibility for canvas control avoidance", () => {
    const onVisibilityChange = vi.fn();
    render(
      <>
        <SidebarToggle />
        <QueueSidebarFrame onVisibilityChange={onVisibilityChange}>
          <span>Queue</span>
        </QueueSidebarFrame>
      </>,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
    enter();
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button"));
    expect(useStore.getState().queueCollapsed).toBe(false);
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
  it("does not show another file's article progress on the current canvas", () => {
    useStore
      .getState()
      .addFile({
        id: "a",
        name: "a.png",
        path: "/a.png",
        ext: "png",
        kind: "image",
      });
    useStore
      .getState()
      .addFile({
        id: "b",
        name: "b.png",
        path: "/b.png",
        ext: "png",
        kind: "image",
      });
    useStore.getState().setCurrent("a");
    useStore
      .getState()
      .startJob({
        kind: "whole_file",
        jobId: "progress-b",
        fileId: "b",
        requestedPages: [1],
        newspaperName: "",
        newspaperDate: "",
      });
    render(<ProgressPill />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    act(() => useStore.getState().setCurrent("b"));
    expect(screen.getByRole("progressbar")).not.toBeNull();
  });
  it("occupies no collapsed width and retracts after the pointer leaves for 180ms", () => {
    render(
      <QueueSidebarFrame>
        <button>File</button>
      </QueueSidebarFrame>,
    );
    expect(QUEUE_COLLAPSED_WIDTH).toBe(0);
    expect(frame().style.visibility).toBe("hidden");
    enter();
    expect(frame().style.visibility).toBe("visible");
    leave();
    act(() => vi.advanceTimersByTime(179));
    expect(frame().style.visibility).toBe("visible");
    act(() => vi.advanceTimersByTime(1));
    expect(frame().style.visibility).toBe("hidden");
  });
  it("keeps a portaled menu or an input open, then retracts when the interaction ends", () => {
    render(
      <QueueSidebarFrame>
        <input aria-label="Search" />
      </QueueSidebarFrame>,
    );
    enter();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    leave();
    act(() => vi.advanceTimersByTime(360));
    expect(frame().style.visibility).toBe("visible");
    menu.remove();
    act(() => screen.getByRole("textbox").focus());
    act(() => vi.advanceTimersByTime(360));
    expect(frame().style.visibility).toBe("visible");
    act(() => screen.getByRole("textbox").blur());
    act(() => vi.advanceTimersByTime(180));
    expect(frame().style.visibility).toBe("hidden");
  });
  it("holds dialogs and drag operations, resets on blur, and stays pinned when expanded", () => {
    const view = render(
      <QueueSidebarFrame held>
        <button>File</button>
      </QueueSidebarFrame>,
    );
    enter();
    leave();
    act(() => vi.advanceTimersByTime(360));
    expect(frame().style.visibility).toBe("visible");
    view.rerender(
      <QueueSidebarFrame>
        <button>File</button>
      </QueueSidebarFrame>,
    );
    fireEvent.dragStart(frame());
    act(() => vi.advanceTimersByTime(360));
    expect(frame().style.visibility).toBe("visible");
    fireEvent.dragEnd(frame());
    act(() => vi.advanceTimersByTime(180));
    expect(frame().style.visibility).toBe("hidden");
    enter();
    fireEvent(window, new Event("blur"));
    expect(frame().style.visibility).toBe("hidden");
    act(() => useStore.getState().setQueueCollapsed(false));
    expect(frame().style.visibility).toBe("visible");
    expect(screen.queryByTestId("queue-peek-edge")).toBeNull();
  });
  it("retracts after a portaled dialog closes without another panel mouseleave", () => {
    const view = render(
      <QueueSidebarFrame held>
        <button>File</button>
      </QueueSidebarFrame>,
    );
    enter();
    fireEvent.mouseEnter(frame());
    // The portal remains a React descendant but is outside the panel's DOM.
    // jsdom has no pointer hit-testing, so supply that browser observation.
    const matches = frame().matches.bind(frame());
    vi.spyOn(frame(), "matches").mockImplementation((selector) =>
      selector === ":hover" ? false : matches(selector),
    );
    view.rerender(
      <QueueSidebarFrame>
        <button>File</button>
      </QueueSidebarFrame>,
    );
    act(() => screen.getByRole("button", { name: "File" }).focus());
    act(() => vi.advanceTimersByTime(180));
    expect(frame().style.visibility).toBe("hidden");
  });
});
