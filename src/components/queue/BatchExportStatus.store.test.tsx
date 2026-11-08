// @vitest-environment jsdom

/**
 * The 导出 action on a finished recognize-only batch, against the REAL store:
 * which batches offer it, and which file ids it hands to the export dialog.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BatchExportStatus } from "./BatchExportDialog";
import { useStore } from "@/store";
import { t } from "@/i18n";
import type { BatchExportItem, BatchExportState } from "@/store/jobSlice";

function item(fileId: string, status: BatchExportItem["status"]): BatchExportItem {
  return {
    fileId,
    name: `${fileId}.png`,
    mode: "whole_file",
    unitCount: 1,
    status,
    done: 0,
    total: 0,
    failedUnits: 0,
  };
}

function setBatch(patch: Partial<BatchExportState>) {
  useStore.getState().setBatchExport({
    status: "done",
    layout: "merged",
    format: "docx",
    items: [item("a", "done"), item("b", "failed"), item("c", "done")],
    currentIndex: null,
    currentJobId: null,
    target: "",
    recognizeOnly: true,
    ...patch,
  });
}

afterEach(() => {
  cleanup();
  useStore.getState().setBatchExport(null);
  for (const id of ["a", "b", "c"]) useStore.getState().removeFile(id);
});

describe("BatchExportStatus — export after recognize", () => {
  it("exports only the recognized files still in the queue", () => {
    for (const id of ["a", "b"]) {
      useStore.getState().addFile({ id, path: `/s/${id}.png`, name: `${id}.png`, ext: "png", kind: "image" });
    }
    // "c" finished recognizing but was removed from the queue since.
    setBatch({});
    const onExport = vi.fn();
    render(<BatchExportStatus onExport={onExport} />);
    fireEvent.click(screen.getByRole("button", { name: t("batch.exportRecognized") }));
    expect(onExport).toHaveBeenCalledWith(["a"]);
  });

  it("is not offered for a cancelled recognize batch or an export batch", () => {
    setBatch({ status: "cancelled" });
    const { rerender } = render(<BatchExportStatus onExport={vi.fn()} />);
    expect(screen.queryByRole("button", { name: t("batch.exportRecognized") })).toBeNull();

    setBatch({ recognizeOnly: false });
    rerender(<BatchExportStatus onExport={vi.fn()} />);
    expect(screen.queryByRole("button", { name: t("batch.exportRecognized") })).toBeNull();
  });
});
