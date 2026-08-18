import type { StateCreator } from "zustand";
import type { QueueSlice } from "./queueSlice";
import type { UiSlice } from "./uiSlice";
import type { FileViewSlice } from "./fileViewSlice";
import type { PageStateSlice } from "./pageStateSlice";
import type { SelectionSlice } from "./selectionSlice";
import type { JobSlice } from "./jobSlice";
import { current } from "immer";
import { setSettings as ipcSetSettings } from "@/lib/tauri";
import { logWarn } from "@/lib/runtime";
import { getLanguage, setLanguage as applyLanguage, type Language } from "@/i18n";
import { en, zh } from "@/i18n/messages";
import {
  appErrorMessage,
  type NonSecretSettings,
  type OcrProfile as IpcOcrProfile,
  type Provider,
  type SecretKey,
} from "@/lib/ipc-types";

/** What we know about whether a credential exists — *not* the credential.
 *  A missing key means "never checked": the UI must stay silent rather than
 *  claim a provider is unconfigured, because nothing has read the Keychain
 *  yet and reading it just to decorate a menu is what used to pop a system
 *  password prompt on an empty cold start. */
export type CredentialPresence = Partial<Record<SecretKey, boolean>>;

export type OcrProfile = IpcOcrProfile;

/** The prompt shown as the placeholder and restored by "Restore default".
 *  Mirrors `config::default_ocr_prompt` on the Rust side, which picks the
 *  same wording for the language stored in the settings. */
export function defaultOcrPrompt(language: Language = getLanguage()): string {
  return (language === "en" ? en : zh)["settings.defaultPrompt"];
}

/** Built-in proofread system prompt, in the active UI language. Mirrors
 *  `config::default_proofread_prompt` on the Rust side. Used three ways:
 *  as the DEFAULT_SETTINGS value, as the hydrate coalesce for old
 *  settings.json files (`proofread_prompt` serde-defaults to ""), and as
 *  the placeholder / restore target in the settings dialog. */
export function defaultProofreadPrompt(
  language: Language = getLanguage()
): string {
  return (language === "en" ? en : zh)["settings.defaultProofreadPrompt"];
}

/** Local defaults mirror the Rust `NonSecretSettings::default()` so the UI
 *  can render before the first `getSettings()` round-trip completes. */
export const DEFAULT_SETTINGS: NonSecretSettings = {
  provider: "openai",
  ocr_profile: "standard",
  // Seeded from the locale hint so a first run on an English system starts
  // in English; `hydrate()` then replaces it with the persisted choice.
  language: getLanguage(),
  ocr_prompt: defaultOcrPrompt(),
  paddle_url: "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs",
  paddle_model: "PaddleOCR-VL-1.6",
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
  openrouter_model: "google/gemini-2.5-flash",
  openai_compatible_base_url: "",
  openai_compatible_model: "",
  proofread_provider: null,
  proofread_model: "",
  proofread_prompt: defaultProofreadPrompt(),
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
  /** Persists the UI language. The active catalog is switched immediately so
   *  the whole app re-renders, and the value rides along in the settings so
   *  the backend can localize job progress and error messages too. */
  setLanguage: (language: Language) => void;
  /** Mirror of `settings.ocr_profile` kept as a top-level key so the
   *  M4-era `ProfileToggle` selector (`s.ocrProfile`) still works after
   *  the slice grew. New code should read `s.settings.ocr_profile`. */
  ocrProfile: OcrProfile;
  /** Populated only by code that had a reason to touch the Keychain anyway
   *  (the settings dialog opening, a save, a delete). Read-only decoration
   *  for the rest of the UI — never a trigger to go query the Keychain. */
  credentialPresence: CredentialPresence;
  mergeCredentialPresence: (entries: CredentialPresence) => void;
  /** Bumped every time a secret is written or deleted. A boolean presence
   *  cannot express "key A replaced with key B" (true → true), so caches
   *  keyed on credential state subscribe to this number instead — see the
   *  proofread model list in `OcrTextPanel`. */
  credentialRevision: number;
  bumpCredentialRevision: () => void;
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
  credentialPresence: {},
  credentialRevision: 0,
  bumpCredentialRevision: () =>
    set((state) => {
      state.credentialRevision += 1;
    }),
  mergeCredentialPresence: (entries) =>
    set((state) => {
      Object.assign(state.credentialPresence, entries);
    }),
  setSettings: (next) =>
    set((state) => {
      // Always spread so the reference changes even when callers pass the same
      // object back (e.g. the settings dialog saves a secret without touching
      // any non-secret field — draft stays === committed, and without this
      // spread immer would no-op the assignment).
      state.settings = { ...next };
      state.settingsLoaded = true;
      state.ocrProfile = next.ocr_profile;
      // Hydration and the settings dialog both land here, so this is the one
      // place that has to keep the message catalog in step with the store.
      if (next.language) applyLanguage(next.language);
    }),
  setProvider: (provider) => {
    let next: NonSecretSettings | null = null;
    set((state) => {
      state.settings.provider = provider;
      next = current(state.settings);
    });
    if (next) void persistSettings(next);
  },
  setOcrProfile: (profile) => {
    let next: NonSecretSettings | null = null;
    set((state) => {
      state.settings.ocr_profile = profile;
      state.ocrProfile = profile;
      next = current(state.settings);
    });
    if (next) void persistSettings(next);
  },
  setLanguage: (language) => {
    let next: NonSecretSettings | null = null;
    set((state) => {
      state.settings.language = language;
      next = current(state.settings);
    });
    applyLanguage(language);
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
    void logWarn(`settings persist failed: ${message}`);
  }
}
