import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createQueueSlice, type QueueSlice } from "./queueSlice";
import { createUiSlice, type UiSlice } from "./uiSlice";

export type AppStore = QueueSlice & UiSlice;

export const useStore = create<AppStore>()(
  immer((...args) => ({
    ...createQueueSlice(...args),
    ...createUiSlice(...args),
  }))
);
