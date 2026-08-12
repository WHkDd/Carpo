import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime, logWarn } from "./runtime";

export const DESKTOP_EVENTS = {
  OPEN_PATHS_AVAILABLE: "carpo://desktop/open-paths-available",
  MENU_OPEN_FILES: "carpo://desktop/menu-open-files",
  MENU_IMPORT_PADDLE_JSON: "carpo://desktop/menu-import-paddle-json",
  MENU_SETTINGS: "carpo://desktop/menu-settings",
  NOTIFICATION_OPEN_FILE: "carpo://desktop/notification-open-file",
} as const;

export interface NotificationOpenPayload {
  fileId: string;
}

let notificationsEnabledForSession = false;

/** Called only from an accepted OCR button action. Checking/requesting here
 *  keeps notification permission work out of the cold-start path. A denied
 *  permission never blocks the OCR job itself. */
export async function enableNotificationsAfterUserAction(): Promise<void> {
  if (!isTauriRuntime() || notificationsEnabledForSession) return;
  try {
    const { isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    );
    notificationsEnabledForSession = await isPermissionGranted();
    if (!notificationsEnabledForSession) {
      notificationsEnabledForSession = (await requestPermission()) === "granted";
    }
  } catch (error) {
    void logWarn(`notification permission request failed: ${String(error)}`);
  }
}

export async function notifyOcrResult(options: {
  fileId: string;
  title: string;
  body: string;
}): Promise<void> {
  if (!isTauriRuntime() || !notificationsEnabledForSession) return;
  try {
    await invoke("notify_ocr_result", {
      fileId: options.fileId,
      title: options.title,
      body: options.body,
    });
  } catch (error) {
    void logWarn(`OCR result notification failed: ${String(error)}`);
  }
}

export async function takePendingOpenPaths(): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  return invoke<string[]>("take_pending_open_paths");
}

export async function setDesktopWindowTitle(title: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setTitle(title);
}
