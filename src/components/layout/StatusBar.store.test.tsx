// @vitest-environment jsdom

/**
 * Rotation buttons against the REAL zustand store. The interesting failures
 * are all at seams a mocked store can't show: the job-slot claim binding to
 * the right file, a batch plan that snapshotted the file's rects, and the
 * async confirm dialog letting state move underneath the click.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "./StatusBar";
import { PageBitmapCacheProvider } from "@/hooks/PageBitmapCacheContext";
import { useStore } from "@/store";
import { t } from "@/i18n";
import { rotateImage } from "@/lib/tauri";
import { confirmDestructive } from "@/lib/confirm";

vi.mock("@/lib/tauri", () => ({
  rotateImage: vi.fn(),
}));
vi.mock("@/lib/confirm", () => ({
  confirmDestructive: vi.fn(async () => true),
}));
vi.mock("@/lib/runtime", async (orig) => ({
  ...(await orig<typeof import("@/lib/runtime")>()),
  logError: vi.fn(async () => {}),
}));

const rotateMock = vi.mocked(rotateImage);
const confirmMock = vi.mocked(confirmDestructive);

function addImage(id: string) {
  useStore.getState().addFile({
    id,
    path: `/tmp/${id}.jpg`,
    name: `${id}.jpg`,
    ext: "jpg",
    kind: "image",
    payload: { width: 400, height: 300, objectUrl: `blob:${id}` },
  });
}

function addBlock(id: string) {
  useStore.getState().addBlock(id, 1, {
    id: "b1",
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    articleId: null,
    articleOrder: null,
  });
}

function renderBar() {
  return render(
    <PageBitmapCacheProvider>
      <StatusBar canvasRef={{ current: null }} />
    </PageBitmapCacheProvider>
  );
}

const rightButton = () =>
  screen.getByRole("button", { name: t("statusBar.rotateRight") });

const pathOf = (id: string) =>
  useStore.getState().files.find((f) => f.id === id)!.path;

beforeEach(() => {
  const state = useStore.getState();
  [...state.files].forEach((file) => state.removeFile(file.id));
  useStore.setState({ batchExport: null, jobStartClaim: null, activeJob: null });
  rotateMock.mockReset();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
});

afterEach(cleanup);

describe("StatusBar rotation against the real store", () => {
  it("is disabled while a running batch still has the file queued", () => {
    addImage("a");
    useStore.setState({
      batchExport: {
        status: "running",
        layout: "separate",
        format: "markdown",
        items: [
          {
            fileId: "a",
            name: "a.jpg",
            mode: "grouped",
            unitCount: 1,
            status: "pending",
            done: 0,
            total: 0,
            failedUnits: 0,
          },
        ],
        currentIndex: null,
        currentJobId: null,
        target: "",
      } as never,
    });
    renderBar();

    expect((rightButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("abandons the rotation if the user switched files during the confirm", async () => {
    addImage("a");
    addImage("b");
    useStore.getState().setCurrent("a");
    addBlock("a");
    let answer: (ok: boolean) => void = () => {};
    confirmMock.mockReturnValue(new Promise((r) => (answer = r)));
    renderBar();

    await act(async () => {
      fireEvent.click(rightButton());
    });
    await act(async () => {
      useStore.getState().setCurrent("b");
      answer(true);
    });

    expect(rotateMock).not.toHaveBeenCalled();
    expect(pathOf("a")).toBe("/tmp/a.jpg");
    expect(useStore.getState().getPageState("a", 1).blocks).toHaveLength(1);
    expect(useStore.getState().jobStartClaim).toBeNull();
  });
});
