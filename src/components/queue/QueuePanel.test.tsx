// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const { startWholeFileOcr, cancelJob, save, open } = vi.hoisted(() => ({
  startWholeFileOcr: vi.fn(async () => ({ job_id: "job-w" })),
  cancelJob: vi.fn(async () => true),
  save: vi.fn(async () => "/tmp/out.docx"),
  open: vi.fn(async () => "/tmp"),
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
vi.mock("@tauri-apps/plugin-dialog", () => ({ save, open }));
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
    />
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
      screen.getByRole("button", { name: t("batch.recognizeSelected") })
    );
    fireEvent.click(screen.getByRole("button", { name: t("batch.start") }));

    await waitFor(() =>
      expect(useStore.getState().batchExport?.recognizeOnly).toBe(true)
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
      screen.getByRole("button", { name: t("batch.exportSelected") })
    );
    fireEvent.click(screen.getByRole("button", { name: t("batch.layout.by_tag") }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: t("common.cancel"),
      })
    );

    fireEvent.click(
      screen.getByRole("button", { name: t("batch.recognizeSelected") })
    );
    expect(
      within(screen.getByRole("dialog")).getAllByText("a.png")
    ).toHaveLength(1);
  });
});
