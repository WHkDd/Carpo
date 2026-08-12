import { isTauriRuntime } from "./runtime";
import { t } from "@/i18n";

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Label for the affirmative button. Defaults to the shared "Delete". */
  confirmLabel?: string;
}

/**
 * Confirms a destructive action with the platform's own dialog.
 *
 * `window.confirm` inside a webview renders Chromium/WebKit's browser alert —
 * wrong chrome, wrong button order, wrong font, and on macOS it is not even
 * app-modal. `tauri-plugin-dialog` puts up the real NSAlert / Win32 task
 * dialog instead. The browser build keeps `window.confirm`, where it *is* the
 * native affordance.
 */
export async function confirmDestructive(
  options: ConfirmOptions
): Promise<boolean> {
  if (!isTauriRuntime()) {
    return window.confirm(`${options.title}\n\n${options.message}`);
  }
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(options.message, {
    title: options.title,
    kind: "warning",
    okLabel: options.confirmLabel ?? t("common.delete"),
    cancelLabel: t("common.cancel"),
  });
}
