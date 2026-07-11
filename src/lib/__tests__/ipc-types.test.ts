import { describe, expect, it } from "vitest";
import { HttpAppError, parseAppError } from "@/lib/ipc-types";

describe("parseAppError", () => {
  it("parses a structured Ocr payload", () => {
    const parsed = parseAppError({
      kind: "Ocr",
      data: { provider: "paddleocr", message: "boom", retryable: true },
    });
    expect(parsed).toEqual({
      kind: "Ocr",
      message: "boom",
      retryable: true,
      provider: "paddleocr",
    });
  });

  it("parses a string-data payload, defaulting retryable off non-Network kinds", () => {
    const parsed = parseAppError({ kind: "Config", data: "missing base_url" });
    expect(parsed.kind).toBe("Config");
    expect(parsed.message).toBe("missing base_url");
    expect(parsed.retryable).toBe(false);
  });

  it("unwraps HttpAppError back to the structured payload underneath", () => {
    const wrapped = new HttpAppError({
      kind: "Ocr",
      data: { provider: "openai", message: "rate limited", retryable: true },
    });
    // A plain `{kind, data}` object fails `instanceof Error` — httpError()
    // wraps it so every fetch() failure is still throwable/catchable as a
    // real Error, without parseAppError losing the structured shape.
    expect(wrapped).toBeInstanceOf(Error);
    const parsed = parseAppError(wrapped);
    expect(parsed).toEqual({
      kind: "Ocr",
      message: "rate limited",
      retryable: true,
      provider: "openai",
    });
  });

  it("falls back to Internal for a plain Error", () => {
    const parsed = parseAppError(new Error("network down"));
    expect(parsed).toEqual({
      kind: "Internal",
      message: "network down",
      retryable: false,
    });
  });

  it("falls back to Internal for an arbitrary string", () => {
    expect(parseAppError("oops")).toEqual({
      kind: "Internal",
      message: "oops",
      retryable: false,
    });
  });
});
