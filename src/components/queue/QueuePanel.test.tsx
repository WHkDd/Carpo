// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("clicking the row body still switches files without unticking", () => {
    renderPanel();
    fireEvent.click(checkbox("b.png"));
    fireEvent.click(screen.getByText("b.png"));
    expect(useStore.getState().currentFileId).toBe("b");
    expect(checkbox("b.png").getAttribute("aria-checked")).toBe("true");
  });

  it("Space ticks the current row", () => {
    renderPanel();
    fireEvent.keyDown(screen.getByRole("grid"), { key: " " });
    expect(checkbox("a.png").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("b.png").getAttribute("aria-checked")).toBe("false");
  });
});
