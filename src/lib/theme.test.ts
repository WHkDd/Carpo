// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MediaStub {
  media: MediaQueryList;
  emit: (matches: boolean) => void;
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function stubMatchMedia(initialMatches: boolean): MediaStub {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const add = vi.fn(
    (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }
  );
  const remove = vi.fn(
    (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }
  );
  const media = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: add,
    removeEventListener: remove,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;

  vi.stubGlobal("matchMedia", vi.fn(() => media));
  return {
    media,
    add,
    remove,
    emit(next) {
      matches = next;
      const event = { matches: next, media: media.media } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

async function loadThemeModule() {
  vi.resetModules();
  return import("./theme");
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme preference", () => {
  it("restores a valid stored preference before the app mounts", async () => {
    stubMatchMedia(false);
    window.localStorage.setItem("carpo.theme", "dark");

    const theme = await loadThemeModule();

    expect(theme.getThemePreference()).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("ignores an invalid stored value and follows the OS", async () => {
    stubMatchMedia(true);
    window.localStorage.setItem("carpo.theme", "sepia");

    const theme = await loadThemeModule();

    expect(theme.getThemePreference()).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("tracks OS changes only while the preference is system", async () => {
    const media = stubMatchMedia(false);
    const theme = await loadThemeModule();
    const stop = theme.watchSystemTheme();

    media.emit(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    theme.setThemePreference("light");
    media.emit(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    stop();
    expect(media.add).toHaveBeenCalledOnce();
    expect(media.remove).toHaveBeenCalledOnce();
  });
});
