// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchExportDialog } from "./BatchExportDialog";
import { useStore } from "@/store";
import { t } from "@/i18n";
import { startBatchExport } from "@/lib/batch-export";
vi.mock("@/lib/batch-export", async (original) => ({
  ...(await original<typeof import("@/lib/batch-export")>()),
  startBatchExport: vi.fn(async () => ({ status: "started" })),
}));
vi.mock("@/lib/runtime", async (original) => ({
  ...(await original<typeof import("@/lib/runtime")>()),
  isTauriRuntime: () => true,
}));
const initial = useStore.getState();
beforeEach(() => {
  useStore.setState(initial, true);
  vi.clearAllMocks();
  useStore
    .getState()
    .addFile({
      id: "a",
      path: "/tmp/a.pdf",
      name: "a.pdf",
      kind: "pdf",
      ext: "pdf",
      pdfTotal: 2,
      currentPage: 1,
    });
  useStore.setState({
    recognizedPages: {
      a: { 1: { text: "Page one", status: "done", sourceMode: "page_image" } },
    },
    recognitionMode: "grouped",
  });
});
afterEach(cleanup);

describe("unified export options", () => {
  it("offers one PDF format, preserves the source checkbox, and only exports existing page results", async () => {
    render(
      <BatchExportDialog
        open
        fileIds={["a"]}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: t("export.withSource") }),
    );
    expect(screen.getByRole("combobox").getAttribute("aria-label")).toBe(
      t("export.scope"),
    );
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
      "whole_file",
    );
    expect(screen.queryByText("版面还原")).toBeNull();
    expect(screen.queryByText("连续阅读")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("export.title") }));
    await waitFor(() =>
      expect(startBatchExport).toHaveBeenCalledWith(
        expect.objectContaining({
          fileIds: ["a"],
          layout: "merged",
          format: "pdf",
          withSource: true,
          exportOnly: true,
          scope: "whole_file",
        }),
      ),
    );
  });
  it("hides comparison for Markdown and cannot start an empty result scope", () => {
    render(
      <BatchExportDialog
        open
        fileIds={["a"]}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    expect(
      screen.queryByRole("checkbox", { name: t("export.withSource") }),
    ).toBeNull();
    expect(
      (
        screen.getByRole("option", {
          name: t("export.scope.grouped"),
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "grouped" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: t("export.title"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
