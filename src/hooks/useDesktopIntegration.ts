import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  DESKTOP_EVENTS,
  setDesktopWindowTitle,
  takePendingOpenPaths,
  type NotificationOpenPayload,
} from "@/lib/desktop";
import { isTauriRuntime, logWarn } from "@/lib/runtime";
import { useStore } from "@/store";

interface DesktopIntegrationOptions {
  openFiles: () => void | Promise<void>;
  importPaths: (paths: string[]) => void | Promise<void>;
  openPaddleJson: () => void | Promise<void>;
  openSettings: () => void;
}

export function useDesktopIntegration({
  openFiles,
  importPaths,
  openPaddleJson,
  openSettings,
}: DesktopIntegrationOptions): void {
  const currentFileName = useStore((state) =>
    state.files.find((file) => file.id === state.currentFileId)?.name ?? null
  );
  const setCurrent = useStore((state) => state.setCurrent);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const title = currentFileName ? `${currentFileName} - Carpo` : "Carpo";
    void setDesktopWindowTitle(title).catch((error) => {
      void logWarn(`window title update failed: ${String(error)}`);
    });
  }, [currentFileName]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    let unlistens: Array<() => void> = [];

    const consumeOpenPaths = async () => {
      try {
        const paths = await takePendingOpenPaths();
        if (!cancelled && paths.length > 0) await importPaths(paths);
      } catch (error) {
        void logWarn(`external file open failed: ${String(error)}`);
      }
    };

    (async () => {
      const subscriptions = await Promise.all([
        listen(DESKTOP_EVENTS.OPEN_PATHS_AVAILABLE, () => {
          void consumeOpenPaths();
        }),
        listen(DESKTOP_EVENTS.MENU_OPEN_FILES, () => {
          void openFiles();
        }),
        listen(DESKTOP_EVENTS.MENU_IMPORT_PADDLE_JSON, () => {
          void openPaddleJson();
        }),
        listen(DESKTOP_EVENTS.MENU_SETTINGS, openSettings),
        listen<NotificationOpenPayload>(
          DESKTOP_EVENTS.NOTIFICATION_OPEN_FILE,
          (event) => {
            const fileId = event.payload.fileId;
            if (useStore.getState().files.some((file) => file.id === fileId)) {
              setCurrent(fileId);
            }
          }
        ),
      ]);
      if (cancelled) {
        subscriptions.forEach((unlisten) => unlisten());
        return;
      }
      unlistens = subscriptions;
      await consumeOpenPaths();
    })().catch((error) => {
      void logWarn(`desktop event setup failed: ${String(error)}`);
    });

    return () => {
      cancelled = true;
      unlistens.forEach((unlisten) => unlisten());
    };
  }, [
    importPaths,
    openFiles,
    openPaddleJson,
    openSettings,
    setCurrent,
  ]);
}
