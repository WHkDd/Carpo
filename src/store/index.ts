import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import {
  createFileViewSlice,
  type FileViewSlice,
} from "./fileViewSlice";
import { createQueueSlice, type QueueSlice } from "./queueSlice";
import { createUiSlice, type UiSlice } from "./uiSlice";
import { createPageStateSlice, type PageStateSlice } from "./pageStateSlice";
import { createSelectionSlice, type SelectionSlice } from "./selectionSlice";
import { createSettingsSlice, type SettingsSlice } from "./settingsSlice";

export type AppStore =
  QueueSlice &
  UiSlice &
  FileViewSlice &
  PageStateSlice &
  SelectionSlice &
  SettingsSlice;

export const useStore = create<AppStore>()(
  immer((...args) => ({
    ...createQueueSlice(...args),
    ...createFileViewSlice(...args),
    ...createUiSlice(...args),
    ...createPageStateSlice(...args),
    ...createSelectionSlice(...args),
    ...createSettingsSlice(...args),
  }))
);
