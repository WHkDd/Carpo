// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLanguage, setLanguage } from "@/i18n";
import { getThemePreference, setThemePreference } from "@/lib/theme";
import { getSecret, setSettings as ipcSetSettings } from "@/lib/tauri";
import { DEFAULT_SETTINGS } from "@/store/settingsSlice";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("@/lib/tauri", () => ({
  deleteSecret: vi.fn(),
  getSecret: vi.fn(),
  listProviderModels: vi.fn(),
  setSecret: vi.fn(),
  setSettings: vi.fn(),
}));

const setCommitted = vi.fn();
const mergeCredentialPresence = vi.fn();
const committed = { ...DEFAULT_SETTINGS, language: "zh" as const };

vi.mock("@/store", () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: committed,
      setSettings: setCommitted,
      mergeCredentialPresence,
    }),
}));

describe("SettingsDialog language selection", () => {
  afterEach(() => {
    cleanup();
    setLanguage("zh");
    setThemePreference("system");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSecret).mockResolvedValue(false);
    vi.mocked(ipcSetSettings).mockResolvedValue(undefined);
    setLanguage("zh");
    setThemePreference("system");
  });

  it("previews the picked language and saves it with the settings", async () => {
    render(<SettingsDialog open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "语言 / Language" }));
    fireEvent.change(screen.getByLabelText("界面语言"), {
      target: { value: "en" },
    });

    // Previewed immediately, before anything is saved.
    await screen.findByText("Settings");
    expect(getLanguage()).toBe("en");
    expect(ipcSetSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(ipcSetSettings).toHaveBeenCalledWith(
        expect.objectContaining({ language: "en" })
      )
    );
    expect(setCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en" })
    );
  });

  it("previews the picked theme and saves it with the settings", async () => {
    render(<SettingsDialog open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "外观" }));
    fireEvent.change(screen.getByLabelText("界面主题"), {
      target: { value: "dark" },
    });

    expect(getThemePreference()).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(ipcSetSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(ipcSetSettings).toHaveBeenCalledWith(
        expect.objectContaining({ theme: "dark" })
      )
    );
    expect(setCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark" })
    );
  });

  it("shows the proofread provider and model fields", async () => {
    // The dedicated proofread pass reuses provider credentials and model
    // selection; the tab surfaces which provider runs it and which model
    // it falls back to, so a user can verify the setup before sending.
    render(<SettingsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "校对" }));
    expect(screen.getByText("校对服务商")).toBeTruthy();
    expect(screen.getByText("校对模型")).toBeTruthy();
    // PaddleOCR is filtered out of the proofread provider list — it can
    // recognize text but cannot chat, so it is never a proofread candidate.
    expect(screen.queryByText("PaddleOCR", { selector: "option" })).toBeNull();
  });

  it("reverts previews when the dialog is closed without saving", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog open onClose={onClose} />);

    fireEvent.click(screen.getByRole("tab", { name: "外观" }));
    fireEvent.change(screen.getByLabelText("界面主题"), {
      target: { value: "dark" },
    });
    expect(getThemePreference()).toBe("dark");

    fireEvent.click(screen.getByRole("tab", { name: "语言 / Language" }));
    fireEvent.change(screen.getByLabelText("界面语言"), {
      target: { value: "en" },
    });
    await screen.findByText("Settings");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
    expect(getLanguage()).toBe("zh");
    expect(getThemePreference()).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(ipcSetSettings).not.toHaveBeenCalled();
  });
});
