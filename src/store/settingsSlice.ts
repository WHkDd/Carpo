import type { StateCreator } from "zustand";
import type { QueueSlice } from "./queueSlice";
import type { UiSlice } from "./uiSlice";
import type { FileViewSlice } from "./fileViewSlice";
import type { PageStateSlice } from "./pageStateSlice";
import type { SelectionSlice } from "./selectionSlice";
import type {
  NonSecretSettings,
  OcrProfile as IpcOcrProfile,
  Provider,
} from "@/lib/ipc-types";

export type OcrProfile = IpcOcrProfile;

/** Local defaults mirror the Rust `NonSecretSettings::default()` so the UI
 *  can render before the first `getSettings()` round-trip completes. */
export const DEFAULT_SETTINGS: NonSecretSettings = {
  provider: "openai",
  ocr_profile: "standard",
  ocr_prompt:
    "请识别并转录图中所有文字。这是一份近代中文报纸的版块图像，文字方向可能为竖排（从上到下，从右到左）或横排。请按原文顺序输出所有文字，不要添加任何解释、标注或格式。",
  paddle_url: "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs",
  paddle_model: "PaddleOCR-VL-1.5",
  openai_model: "gpt-4o",
  openrouter_model: "google/gemini-2.5-flash-preview",
  openai_compatible_base_url: "",
  openai_compatible_model: "",
};

export interface SettingsSlice {
  /** Source-of-truth settings, hydrated from `tauri-plugin-store` on app start.
   *  The settings dialog edits a local draft and writes back via `setSettings`. */
  settings: NonSecretSettings;
  /** True after the first `hydrate()` succeeds — gates UI that needs real
   *  values rather than the defaults. */
  settingsLoaded: boolean;
  setSettings: (next: NonSecretSettings) => void;
  setProvider: (provider: Provider) => void;
  setOcrProfile: (profile: OcrProfile) => void;
  /** Mirror of `settings.ocr_profile` kept as a top-level key so the
   *  M4-era `ProfileToggle` selector (`s.ocrProfile`) still works after
   *  the slice grew. New code should read `s.settings.ocr_profile`. */
  ocrProfile: OcrProfile;
}

export const createSettingsSlice: StateCreator<
  QueueSlice &
    UiSlice &
    FileViewSlice &
    PageStateSlice &
    SelectionSlice &
    SettingsSlice,
  [["zustand/immer", never]],
  [],
  SettingsSlice
> = (set) => ({
  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,
  ocrProfile: DEFAULT_SETTINGS.ocr_profile,
  setSettings: (next) =>
    set((state) => {
      state.settings = next;
      state.settingsLoaded = true;
      state.ocrProfile = next.ocr_profile;
    }),
  setProvider: (provider) =>
    set((state) => {
      state.settings.provider = provider;
    }),
  setOcrProfile: (profile) =>
    set((state) => {
      state.settings.ocr_profile = profile;
      state.ocrProfile = profile;
    }),
});
