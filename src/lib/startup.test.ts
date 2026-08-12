// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyStartupAppearance, prewarmFallbackFonts } from "./startup";

afterEach(() => {
  document.documentElement.className = "";
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});

describe("desktop startup", () => {
  it("keeps the current light-only paint consistent", () => {
    document.documentElement.classList.add("dark");

    applyStartupAppearance();

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("prewarms fallback fonts only in Tauri and removes the probe", () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });

    prewarmFallbackFonts();
    const probe = document.querySelector('[aria-hidden="true"]');
    expect(probe?.textContent).toContain("日本語");

    frames.shift()?.(0);
    frames.shift()?.(16);
    expect(probe?.isConnected).toBe(false);
  });
});
