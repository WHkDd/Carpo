// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDesktopWindowTitle } from "../desktop";

const { isTauriRuntime, getCurrentWindow, setTitle } = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(),
  getCurrentWindow: vi.fn(),
  setTitle: vi.fn(),
}));

vi.mock("../runtime", () => ({ isTauriRuntime, logWarn: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow }));

beforeEach(() => {
  vi.clearAllMocks();
  isTauriRuntime.mockReturnValue(true);
  getCurrentWindow.mockReturnValue({ setTitle });
  setTitle.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllGlobals());

describe("native window title", () => {
  it.each([
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    "Mozilla/5.0 (Macintosh; Apple Silicon Mac OS X 15_0) AppleWebKit/605.1.15",
  ])("keeps macOS traffic lights stable through import, switch and clear: %s", async (userAgent) => {
    vi.stubGlobal("navigator", { userAgent });
    for (const title of ["Carpo", "first.jpg - Carpo", "second.jpg - Carpo", "Carpo"]) {
      await setDesktopWindowTitle(title);
    }
    expect(getCurrentWindow).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
  });

  it.each([
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Mozilla/5.0 (X11; Linux x86_64)",
  ])("preserves dynamic titles on other desktop platforms: %s", async (userAgent) => {
    vi.stubGlobal("navigator", { userAgent });
    await setDesktopWindowTitle("scan.jpg - Carpo");
    await setDesktopWindowTitle("Carpo");
    expect(setTitle.mock.calls).toEqual([["scan.jpg - Carpo"], ["Carpo"]]);
  });

  it("does not access the native window in the browser", async () => {
    isTauriRuntime.mockReturnValue(false);
    await setDesktopWindowTitle("scan.jpg - Carpo");
    expect(getCurrentWindow).not.toHaveBeenCalled();
  });
});
