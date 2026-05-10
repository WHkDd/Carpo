import type { StateCreator } from "zustand";
import type { QueueSlice } from "./queueSlice";
import type { UiSlice } from "./uiSlice";
import type { FileViewSlice } from "./fileViewSlice";
import type { PageStateSlice } from "./pageStateSlice";
import type { SelectionSlice } from "./selectionSlice";

export type OcrProfile = "standard" | "fast";

export interface SettingsSlice {
  ocrProfile: OcrProfile;
  setOcrProfile: (profile: OcrProfile) => void;
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
  ocrProfile: "standard",
  setOcrProfile: (profile) =>
    set((state) => {
      state.ocrProfile = profile;
    }),
});
