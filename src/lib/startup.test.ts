// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyStartupAppearance, prewarmFallbackFonts } from "./startup";
import { setThemePreference } from "./theme";

function stubMatchMedia(matchesDark: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: matchesDark,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  );
}

beforeEach(() => {
  stubMatchMedia(false);
  setThemePreference("system");
});

afterEach(() => {
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
  window.localStorage.clear();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});

describe("desktop startup", () => {
  it("paints the resolved scheme for each of the three start paths", () => {
    // System + light OS → light first frame, matching the old contract.
    applyStartupAppearance();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");

    // System + dark OS → dark, no flash of light in between.
    stubMatchMedia(true);
    setThemePreference("system");
    applyStartupAppearance();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");

    // Forced light wins over a dark OS setting.
    stubMatchMedia(true);
    setThemePreference("light");
    applyStartupAppearance();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");

    // Forced dark wins over a light OS setting.
    setThemePreference("dark");
    applyStartupAppearance();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("resolves a stale dark class left over from a previous session", () => {
    // The module-level bootstrap already applied the localStorage preference;
    // applyStartupAppearance must converge the document either way.
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
    stubMatchMedia(false);
    setThemePreference("system");
    applyStartupAppearance();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("prewarms fallback fonts only in Tauri and removes the probe", () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
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
