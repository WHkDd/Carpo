import type { StateCreator } from "zustand";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import type { QueueSlice } from "./queueSlice";
import type { UiSlice } from "./uiSlice";
import type { FileViewSlice } from "./fileViewSlice";
import type { PageStateSlice } from "./pageStateSlice";
import type { SelectionSlice } from "./selectionSlice";
import type { JobSlice } from "./jobSlice";
import { setSettings as ipcSetSettings } from "@/lib/tauri";
import {
  appErrorMessage,
  type NonSecretSettings,
  type OcrProfile as IpcOcrProfile,
  type Provider,
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
  paddle_document_options: {
    includeHeader: true,
    includeFooter: true,
    includePageNumber: true,
    includeAsideText: true,
    includeHeaderImage: false,
    includeFooterImage: false,
    includeFootnote: true,
    useDocOrientationClassify: false,
    useDocUnwarping: false,
    useLayoutDetection: true,
    useChartRecognition: false,
    useSealRecognition: true,
    useOcrForImageBlock: false,
    mergeTables: true,
    relevelTitles: true,
    layoutShapeMode: "auto",
    promptLabel: "ocr",
    repetitionPenalty: 1,
    temperature: 0,
    topP: 1,
    minPixels: 147384,
    maxPixels: 2822400,
    layoutNms: true,
    restructurePages: true,
  },
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
    SettingsSlice &
    JobSlice,
  [["zustand/immer", never]],
  [],
  SettingsSlice
> = (set) => ({
  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,
  ocrProfile: DEFAULT_SETTINGS.ocr_profile,
  setSettings: (next) =>
    set((state) => {
      // Always spread so the reference changes even when callers pass the same
      // object back (e.g. the settings dialog saves a secret without touching
      // any non-secret field — draft stays === committed, and without this
      // spread immer would no-op the assignment and subscribers like the
      // StatusBar's Keychain probe wouldn't re-fire.
      state.settings = { ...next };
      state.settingsLoaded = true;
      state.ocrProfile = next.ocr_profile;
    }),
  setProvider: (provider) => {
    let next: NonSecretSettings | null = null;
    set((state) => {
      state.settings.provider = provider;
      next = { ...state.settings };
    });
    if (next) void persistSettings(next);
  },
  setOcrProfile: (profile) => {
    let next: NonSecretSettings | null = null;
    set((state) => {
      state.settings.ocr_profile = profile;
      state.ocrProfile = profile;
      next = { ...state.settings };
    });
    if (next) void persistSettings(next);
  },
});

// Fire-and-forget persist to the Tauri store so the backend's `config::load`
// sees the same provider/profile the user picked in the StatusBar dropdown.
// Without this, the in-memory Zustand state and the on-disk settings.json
// can diverge — every OCR job re-reads settings from disk and would otherwise
// run against the last *Save*-ed provider regardless of the StatusBar choice.
async function persistSettings(next: NonSecretSettings): Promise<void> {
  try {
    await ipcSetSettings(next);
  } catch (e) {
    const message = appErrorMessage(e);
    void logWarn(`settings persist failed: ${message}`).catch(() => {});
  }
}
