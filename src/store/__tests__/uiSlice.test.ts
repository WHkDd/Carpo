import { describe, expect, it } from "vitest";
import {
  CANVAS_MIN_WIDTH,
  QUEUE_COLLAPSED_WIDTH,
  QUEUE_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  railMaxWidth,
} from "../uiSlice";

describe("railMaxWidth", () => {
  it("caps at double the default width once the shell is roomy enough", () => {
    expect(railMaxWidth(2000, QUEUE_WIDTH)).toBe(RAIL_MAX_WIDTH);
    expect(RAIL_MAX_WIDTH).toBe(RAIL_MIN_WIDTH * 2);
  });

  it("gives back whatever the queue and canvas floor leave over", () => {
    const shell = QUEUE_WIDTH + CANVAS_MIN_WIDTH + 400;
    expect(railMaxWidth(shell, QUEUE_WIDTH)).toBe(400);
  });

  it("frees up room for the rail when the queue is collapsed", () => {
    const shell = QUEUE_WIDTH + CANVAS_MIN_WIDTH + 400;
    expect(railMaxWidth(shell, QUEUE_COLLAPSED_WIDTH)).toBe(
      400 + (QUEUE_WIDTH - QUEUE_COLLAPSED_WIDTH)
    );
  });

  it("never reports less than the default width", () => {
    // Narrower than the configured window minimum: there is nothing left to
    // give, so the rail holds its floor and the canvas absorbs the squeeze.
    expect(railMaxWidth(600, QUEUE_WIDTH)).toBe(RAIL_MIN_WIDTH);
    expect(railMaxWidth(0, QUEUE_WIDTH)).toBe(RAIL_MIN_WIDTH);
  });

  it("allows a real drag range at the smallest window the app permits", () => {
    // `minWidth` in tauri.conf.json.
    expect(railMaxWidth(1180, QUEUE_WIDTH)).toBeGreaterThan(RAIL_MIN_WIDTH);
  });
});
