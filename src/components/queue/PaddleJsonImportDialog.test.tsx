// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { save } from "@tauri-apps/plugin-dialog";
import {
  exportLayoutPdf,
  importPaddleJson,
} from "@/lib/tauri";
import { PaddleJsonImportDialog } from "./PaddleJsonImportDialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-log", () => ({ warn: vi.fn() }));

vi.mock("@/lib/tauri", () => ({
  analyzePaddleJson: vi.fn(),
  exportLayoutPdf: vi.fn(),
  exportReadingMarkdown: vi.fn(),
  importPaddleJson: vi.fn(),
}));

vi.mock("@/store", () => {
  const store = {
    currentFileId: null,
    files: [],
    setRecognizedPages: vi.fn(),
    setRecognitionMode: vi.fn(),
    setCurrentPage: vi.fn(),
  };
  return { useStore: (selector: (state: typeof store) => unknown) => selector(store) };
});

const imported = {
  preflight: {
    pageCount: 1,
    blockCount: 6,
    labelCounts: { text: 1, header: 2, vision_footnote: 3 },
    modelSettings: null,
    markdownIgnoreLabels: [],
    hasParsingResults: true,
    hasBlockBbox: true,
    hasBlockOrder: true,
    hasPolygonPoints: true,
    hasMarkdown: true,
    hasImages: false,
    hasOutputImages: false,
    warnings: ["页面尺寸由 bbox 估算"],
  },
  document: {
    source: "paddle",
    pages: [{ index: 1, width: 100, height: 100, blocks: [] }],
  },
  pageTexts: [{ page: 1, text: "正文" }],
};

describe("PaddleJsonImportDialog export feedback", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importPaddleJson).mockResolvedValue(imported);
    vi.mocked(save).mockResolvedValue("/tmp/output.pdf");
    vi.mocked(exportLayoutPdf).mockResolvedValue({
      targetPath: "/tmp/output.pdf",
      pageCount: 2,
      warningCount: 2,
      warnings: ["图片区块未嵌入", "已过滤重复页眉"],
    });
  });

  it("separates import warnings and expands concrete export warnings", async () => {
    render(
      <PaddleJsonImportDialog open path="/tmp/input.json" onClose={vi.fn()} />
    );

    expect(await screen.findByText("导入检查提示")).toBeTruthy();
    expect(screen.getByText("页面尺寸由 bbox 估算")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "导出阅读版 PDF" }));

    await waitFor(() => {
      expect(screen.getByText("已导出 PDF 2 页")).toBeTruthy();
    });
    const toggle = screen.getByRole("button", { name: /查看 2 条导出提示/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // The panel stays in the DOM (so aria-controls always resolves) but is
    // hidden until expanded.
    const panel = document.getElementById("paddle-export-warnings")!;
    expect(panel.hidden).toBe(true);

    fireEvent.click(toggle);
    expect(panel.hidden).toBe(false);
    expect(screen.getByText("图片区块未嵌入")).toBeTruthy();
    expect(screen.getByText("已过滤重复页眉")).toBeTruthy();
    const expandedToggle = screen.getByRole("button", {
      name: /收起 2 条导出提示/,
    });
    expect(expandedToggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("disables export options whose block label is absent from the file", async () => {
    render(
      <PaddleJsonImportDialog open path="/tmp/input.json" onClose={vi.fn()} />
    );
    await screen.findByText("阅读版导出选项");

    const checkbox = (name: RegExp) =>
      screen.getByRole("checkbox", { name }) as HTMLInputElement;

    // Present in labelCounts → enabled, block count shown.
    const header = checkbox(/^页眉/);
    expect(header.disabled).toBe(false);
    expect(header.closest("label")?.textContent).toContain("2");
    const footnote = checkbox(/^脚注/);
    expect(footnote.disabled).toBe(false);
    expect(footnote.closest("label")?.textContent).toContain("3");

    // Absent → disabled, shown as 无, and rendered unchecked even where the
    // default option is on (表格 defaults to true).
    for (const name of [/^表格/, /^旁注/, /^页脚/]) {
      const box = checkbox(name);
      expect(box.disabled).toBe(true);
      expect(box.checked).toBe(false);
      expect(box.closest("label")?.textContent).toContain("无");
    }

    // The synthesized page anchor is not label-gated and never disabled.
    expect(checkbox(/^源文件页锚/).disabled).toBe(false);
  });
});
