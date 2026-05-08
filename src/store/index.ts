import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import {
  createPageStateSlice,
  type PageStateSlice,
} from "./pageStateSlice";
import { createQueueSlice, type QueueSlice } from "./queueSlice";
import { createUiSlice, type UiSlice } from "./uiSlice";

export type AppStore = QueueSlice & UiSlice & PageStateSlice;

export const useStore = create<AppStore>()(
  immer((...args) => ({
    ...createQueueSlice(...args),
    ...createPageStateSlice(...args),
    ...createUiSlice(...args),
  }))
);
