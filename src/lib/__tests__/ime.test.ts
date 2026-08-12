import { describe, expect, it } from "vitest";
import { isImeCommit } from "../ime";

describe("isImeCommit", () => {
  it("recognizes active composition on native and React events", () => {
    expect(isImeCommit({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(
      isImeCommit({ nativeEvent: { isComposing: true, keyCode: 13 } })
    ).toBe(true);
  });

  it("recognizes the WebView2 keyCode 229 fallback", () => {
    expect(isImeCommit({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("does not suppress a normal Enter key", () => {
    expect(isImeCommit({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
