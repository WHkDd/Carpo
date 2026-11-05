import { describe, expect, it } from "vitest";
import { QUEUE_WIDTH, RAIL_MIN_WIDTH, railMaxWidth } from "../uiSlice";

describe("railMaxWidth", () => {
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
