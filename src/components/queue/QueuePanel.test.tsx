// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const { startWholeFileOcr, cancelJob, save, open, ask } = vi.hoisted(() => ({
  startWholeFileOcr: vi.fn(async () => ({ job_id: "job-w" })),
  cancelJob: vi.fn(async () => true),
  save: vi.fn(async () => "/tmp/out.docx"),
  open: vi.fn(async () => "/tmp"),
  ask: vi.fn(async () => true),
}));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  getSecret: vi.fn(async () => true),
  startWholeFileOcr,
  cancelJob,
}));
// Desktop runtime, so a batch that did want an output file would reach the
// destination picker below.
vi.mock("@/lib/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save, open, ask }));
vi.mock("@/lib/desktop", () => ({
  enableNotificationsAfterUserAction: vi.fn(async () => {}),
  notifyOcrResult: vi.fn(async () => {}),
}));
import { useStore } from "@/store";
import { t } from "@/i18n";
import { QueuePanel } from "./QueuePanel";

const INITIAL = useStore.getState();

function addImage(id: string) {
  useStore.getState().addFile({
    id,
    path: `/tmp/${id}.png`,
    name: `${id}.png`,
    ext: "png",
    kind: "image",
  });
}

function renderPanel() {
  render(
    <QueuePanel
      onOpenFiles={vi.fn()}
      onImportPaddleJson={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: t("batch.button") }));
}

const checkbox = (name: string) =>
  screen.getByRole("checkbox", { name: t("batch.selectFile", { name }) });

beforeEach(() => {
  useStore.setState(INITIAL, true);
  vi.clearAllMocks();
  addImage("a");
  addImage("b");
  useStore.getState().setCurrent("a");
});
afterEach(() => {
  cleanup();
  useStore.setState(INITIAL, true);
});

describe("QueuePanel selection mode", () => {
  it("ticking a row neither opens it nor lets Delete remove the open file", () => {
    renderPanel();
    fireEvent.click(checkbox("b.png"));
    expect(checkbox("b.png").getAttribute("aria-checked")).toBe("true");
    expect(useStore.getState().currentFileId).toBe("a");

    fireEvent.keyDown(screen.getByRole("grid"), { key: "Delete" });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Backspace" });
    expect(useStore.getState().files.map((f) => f.id)).toEqual(["a", "b"]);
  });

  // 批量识别 and 批量识别导出 are separate actions: the first must not ask
  // where to put an output file it never writes.
  it("识别 starts an OCR-only batch without asking for a destination", async () => {
    renderPanel();
    fireEvent.click(checkbox("a.png"));
    fireEvent.click(
      screen.getByRole("button", { name: t("batch.recognizeSelected") }),
    );
    fireEvent.click(screen.getByRole("button", { name: t("batch.start") }));

    await waitFor(() =>
      expect(useStore.getState().batchExport?.recognizeOnly).toBe(true),
    );
    expect(save).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await waitFor(() => expect(startWholeFileOcr).toHaveBeenCalled());
  });

  // The dialog keeps the export layout between openings; 识别 has no output
  // documents, so a two-tag file must not be previewed once per tag.
  it("识别 previews each file once after an export chose 按 tag 合并", () => {
    useStore.getState().addTagToFiles(["a"], "A");
    useStore.getState().addTagToFiles(["a"], "B");
    renderPanel();
    fireEvent.click(checkbox("a.png"));

    fireEvent.click(
      screen.getByRole("button", { name: t("batch.exportSelected") }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: t("batch.layout.by_tag") }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: t("common.cancel"),
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: t("batch.recognizeSelected") }),
    );
    expect(
      within(screen.getByRole("dialog")).getAllByText("a.png"),
    ).toHaveLength(1);
  });
});

describe("QueuePanel queue tools", () => {
  const panel = () =>
    render(
      <QueuePanel
        onOpenFiles={vi.fn()}
        onImportPaddleJson={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
  const cell = (id: string) =>
    document.querySelector<HTMLDivElement>(
      `[data-queue-id="${id}"] [role="gridcell"]`,
    )!;

  it("seeds batch mode from a multiple selection, and applies right-click actions only to their target", () => {
    panel();
    fireEvent.click(cell("b"), { metaKey: true });
    expect(useStore.getState().selectedQueueFileIds).toEqual(["a", "b"]);
    fireEvent.click(screen.getByRole("button", { name: t("batch.button") }));
    expect(checkbox("a.png").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("b.png").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: t("common.cancel") }));
    fireEvent.click(cell("a"));
    fireEvent.contextMenu(cell("b"));
    fireEvent.click(screen.getByRole("menuitem", { name: t("queue.setDate") }));
    fireEvent.change(
      screen.getByRole("textbox", { name: t("queue.setDate") }),
      { target: { value: "1936-05-12" } },
    );
    fireEvent.click(screen.getByRole("button", { name: t("batch.apply") }));
    expect(useStore.getState().documentStates.b?.newspaperDate).toBe(
      "1936-05-12",
    );
    expect(useStore.getState().documentStates.a?.newspaperDate).toBeUndefined();
  });

  it("confirms and removes a selected group, without touching an unselected file", async () => {
    addImage("c");
    useStore.getState().setCurrent("a");
    panel();
    fireEvent.click(cell("b"), { metaKey: true });
    fireEvent.contextMenu(cell("a"));
    fireEvent.click(screen.getByRole("menuitem", { name: t("queue.remove") }));
    await waitFor(() =>
      expect(useStore.getState().files.map((file) => file.id)).toEqual(["c"]),
    );
    expect(ask).toHaveBeenCalledOnce();
  });

  it("filters batch select-all, renders only 20 hits initially, and preserves expanded hits after navigation", async () => {
    useStore
      .getState()
      .setRecognizedPages("a", {
        1: {
          text: "上海新聞".repeat(25),
          status: "done",
          sourceMode: "page_image",
        },
      });
    panel();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "上海新闻" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: t("queue.moreHits", { count: 5 }) }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: t("batch.button") }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: t("batch.selectAll") }),
    );
    expect(checkbox("a.png").getAttribute("aria-checked")).toBe("true");
    expect(
      screen.queryByRole("checkbox", {
        name: t("batch.selectFile", { name: "b.png" }),
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: t("queue.moreHits", { count: 5 }) }),
    );
    const hit = screen
      .getAllByRole("button")
      .find((button) =>
        button.textContent?.startsWith(t("queue.searchPage", { page: 1 })),
      )!;
    fireEvent.click(hit);
    expect(useStore.getState().recognitionMode).toBe("whole_file");
    expect(
      screen.getByRole("button", { name: t("queue.fewerHits") }),
    ).toBeTruthy();
    // A page change is view state, not a new search input.
    act(() =>
      useStore
        .getState()
        .setFilePayload("a", {
          width: 100,
          height: 100,
          objectUrl: "blob:preview",
        }),
    );
    expect(
      screen.getByRole("button", { name: t("queue.fewerHits") }),
    ).toBeTruthy();
  });

  it("deduplicates tag groups for batch actions", async () => {
    useStore.getState().addTagToFiles(["a"], "甲");
    useStore.getState().addTagToFiles(["a", "b"], "乙");
    panel();
    fireEvent.click(screen.getByRole("button", { name: t("queue.group") }));
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: t("queue.group.tag") }),
    );
    fireEvent.click(cell("b"), { metaKey: true });
    fireEvent.contextMenu(cell("a"));
    fireEvent.click(screen.getByRole("menuitem", { name: t("queue.star") }));
    expect(useStore.getState().files.every((file) => file.isStarred)).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: t("batch.button") }));
    expect(
      screen
        .getAllByRole("checkbox", {
          name: t("batch.selectFile", { name: "a.png" }),
        })
        .every((box) => box.getAttribute("aria-checked") === "true"),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: t("batch.recognizeSelected") }),
    );
    expect(
      within(screen.getByRole("dialog")).getAllByText("a.png"),
    ).toHaveLength(1);
  });
});
