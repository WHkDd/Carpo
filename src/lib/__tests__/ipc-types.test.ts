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
});
