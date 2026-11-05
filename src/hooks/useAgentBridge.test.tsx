// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { invoke, callbacks, downloadBlob } = vi.hoisted(() => ({
  invoke: vi.fn(
    async (_command: string, _args?: unknown): Promise<unknown> => undefined,
  ),
  callbacks: new Map<string, (event: { payload: unknown }) => void>(),
  downloadBlob: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name, callback) => {
    callbacks.set(name, callback);
    return () => callbacks.delete(name);
  }),
}));
vi.mock("@/lib/runtime", async (original) => ({
  ...(await original<typeof import("@/lib/runtime")>()),
  isTauriRuntime: () => true,
  downloadBlob,
}));
vi.mock("@/lib/tauri", async (original) => ({
  ...(await original<typeof import("@/lib/tauri")>()),
  getSecret: vi.fn(async () => true),
}));
import { dispatchAgentRequest, useAgentBridge } from "./useAgentBridge";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { setLanguage } from "@/i18n";
import { useStore } from "@/store";
import type { LayoutPage } from "@/lib/layout-document";
const initial = useStore.getState();
const request = (method: string, path: string, body: unknown = {}) =>
  dispatchAgentRequest({ method, path, body }, async () => {});
function addFile() {
  useStore.getState().addFile({
    id: "f",
    path: "/scan.png",
    name: "scan.png",
    ext: "png",
    kind: "image",
  });
}
beforeEach(() => {
  useStore.setState(initial, true);
  vi.clearAllMocks();
  callbacks.clear();
});
afterEach(() => {
  cleanup();
  useStore.setState(initial, true);
  setLanguage("zh");
});
describe("agent bridge with the real store", () => {
  it("mounts with no files, stays stable after store updates, replies through IPC", async () => {
    const hook = renderHook(() => useAgentBridge(async () => {}));
    await waitFor(() =>
      expect(callbacks.has("carpo://agent/request")).toBe(true),
    );
    act(addFile);
    hook.rerender();
    callbacks.get("carpo://agent/request")!({
      payload: { id: "r", method: "GET", path: "/v1/status", body: {} },
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "agent_bridge_reply",
        expect.objectContaining({
          id: "r",
          ok: true,
          data: expect.objectContaining({ fileCount: 1 }),
        }),
      ),
    );
    hook.unmount();
    expect(callbacks.size).toBe(0);
  });
  it("imports through pending desktop paths then returns real store ids", async () => {
    invoke.mockResolvedValueOnce(["/scan.png"] as never);
    const result = await dispatchAgentRequest(
      {
        method: "POST",
        path: "/v1/files/import",
        body: { paths: ["/scan.png"] },
      },
      async (paths) => {
        expect(paths).toEqual(["/scan.png"]);
        addFile();
      },
    );
    expect(result).toMatchObject({ fileIds: ["f"] });
  });
  it("recognizes without picker or output, reusing stored text", async () => {
    addFile();
    useStore.getState().setPageOcrTexts("f", { 1: "原文" });
    expect(await request("POST", "/v1/ocr/batch", { fileIds: ["f"] })).toEqual({
      status: "started",
    });
    await waitFor(() =>
      expect(useStore.getState().batchExport?.status).toBe("done"),
    );
    expect(useStore.getState().batchExport?.items[0]?.status).toBe("done");
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});

describe("agent review safety", () => {
  const suggestion = {
    before: "聞",
    after: "闻",
    context_before: "新",
    category: "charform",
    confidence: 1,
    reason: "字形",
  };
  function seed() {
    addFile();
    useStore.getState().setPageOcrTexts("f", { 1: "新聞" });
  }
  it.each(["empty", "identical"] as const)(
    "keeps layout export intact and allows replacing an applied-request %s no-op",
    async (kind) => {
      seed();
      const layout: LayoutPage = {
        index: 1,
        width: 100,
        height: 100,
        blocks: [
          { label: "text", text: "新", bbox: [0, 0, 40, 100], order: 1 },
          { label: "text", text: "聞", bbox: [50, 0, 100, 100], order: 2 },
        ],
      };
      useStore.getState().setRecognizedPages("f", {
        1: { text: "新聞", status: "done", sourceMode: "page_image", layout },
      });
      const result = await request("POST", "/v1/files/f/units/page:1/review", {
        baseText: "新聞",
        suggestions: kind === "empty" ? [] : [{ ...suggestion, after: "聞" }],
        apply: true,
      });
      expect(result).toMatchObject({ review: { status: "pending" } });
      expect(useStore.getState().recognizedPages.f?.[1]?.textEdited).toBeFalsy();

      await request("POST", "/v1/export", {
        fileIds: ["f"],
        layout: "merged",
        format: "layout-pdf",
        target: "/output/result.pdf",
      });
      expect(invoke).toHaveBeenCalledWith("agent_bridge_write_export", {
        output: {
          target: "/output/result.pdf",
          stem: undefined,
          format: "layout-pdf",
          document: { source: "paddle", pages: [layout] },
        },
      });
      await request("POST", "/v1/files/f/units/page:1/review", {
        baseText: "新聞",
        suggestions: [suggestion],
        apply: true,
      });
      expect(useStore.getState().pageOcrTexts.f?.[1]).toBe("新闻");
    },
  );
  it("creates a review without changing text, applies on request and preserves undo", async () => {
    seed();
    const body = {
      baseText: "新聞",
      suggestions: [{ ...suggestion, category: "semantic" }],
    };
    await request("POST", "/v1/files/f/units/page:1/review", body);
    expect(useStore.getState().proofreadReviews.f?.["page:1"]?.status).toBe(
      "pending",
    );
    expect(useStore.getState().pageOcrTexts.f?.[1]).toBe("新聞");

    await request("POST", "/v1/files/f/units/page:1/review", {
      ...body,
      apply: true,
    });
    expect(useStore.getState().pageOcrTexts.f?.[1]).toBe("新闻");
    await expect(
      request("POST", "/v1/files/f/units/page:1/review", {
        baseText: "新闻",
        suggestions: [],
      }),
    ).rejects.toThrow("undo or discard");
    expect(useStore.getState().undoProofreadReview("f", "page:1")).toBe(true);
    expect(useStore.getState().pageOcrTexts.f?.[1]).toBe("新聞");
  });
  it("rejects stale and invalid anchors without modifying reviews", async () => {
    seed();
    await expect(
      request("POST", "/v1/files/f/units/page:1/review", {
        baseText: "old",
        suggestions: [suggestion],
        apply: true,
      }),
    ).rejects.toThrow("stale");
    await expect(
      request("POST", "/v1/files/f/units/page:1/review", {
        baseText: "新聞",
        suggestions: [{ ...suggestion, before: "missing" }],
      }),
    ).rejects.toThrow("anchor");
    expect(useStore.getState().proofreadReviews.f).toBeUndefined();
  });
});

describe("agent export wiring", () => {
  function seed() {
    addFile();
    useStore.getState().setPageOcrTexts("f", { 1: "已校对文本" });
  }
  it("exports current text to the explicit target and records the output path", async () => {
    seed();
    invoke.mockResolvedValueOnce({ targetPath: "/output/result.md" });
    expect(
      await request("POST", "/v1/export", {
        fileIds: ["f"],
        layout: "merged",
        format: "md",
        target: "/output/result.md",
      }),
    ).toEqual({ status: "started" });
    await waitFor(() =>
      expect(useStore.getState().batchExport?.status).toBe("done"),
    );
    const output = invoke.mock.calls.find(
      (call) => call[0] === "agent_bridge_write_export",
    )![1] as {
      output: { target: string; data: number[] };
    };
    expect(output.output.target).toBe("/output/result.md");
    expect(
      new TextDecoder().decode(new Uint8Array(output.output.data)),
    ).toContain("已校对文本");
    expect(useStore.getState().batchExport?.outputs).toEqual([
      "/output/result.md",
    ]);
  });
  it("keeps native write errors observable in batch progress", async () => {
    seed();
    invoke.mockRejectedValueOnce(new Error("target denied"));
    await request("POST", "/v1/export", {
      fileIds: ["f"],
      layout: "separate",
      format: "md",
      target: "/output",
    });
    await waitFor(() =>
      expect(useStore.getState().batchExport?.status).toBe("done"),
    );
    expect(useStore.getState().batchExport?.items[0]?.error).toContain(
      "target denied",
    );
  });
});

describe("agent settings", () => {
  it("persists toggle immediately and exposes skill installation instructions", async () => {
    setLanguage("zh");
    render(<SettingsDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Agent" }));
    const checkbox = screen.getByRole("checkbox", { name: "允许 agent 控制" });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(useStore.getState().settings.agent_bridge_enabled).toBe(true),
    );
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      s: expect.objectContaining({ agent_bridge_enabled: true }),
    });
    expect(
      (screen.getByLabelText("安装 Carpo skill") as HTMLTextAreaElement).value,
    ).toContain("/v1/skill");
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(useStore.getState().settings.agent_bridge_enabled).toBe(false),
    );
  });
});
