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

export interface AlertOptions {
  title: string;
  message: string;
}

/**
 * Reports a failure the user has to acknowledge — a file that could not be
 * written, an export that died halfway — through the platform's own error
 * dialog. A line of red text inside a panel is a web habit; a failed write is
 * exactly what `NSAlert` / `MessageBox` exist for.
 *
 * Returns `false` when there is no native dialog available (the browser
 * build), which is the caller's cue to render the message inline instead.
 * Unlike `confirmDestructive` this does *not* fall back to `window.alert`:
 * a confirm needs a blocking yes/no answer and `window.confirm` is the only
 * way to get one, whereas an error only needs to be shown, and an inline
 * message is both less disruptive and better placed than the browser's own
 * modal.
 */
export async function alertError(options: AlertOptions): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  const { message } = await import("@tauri-apps/plugin-dialog");
  await message(options.message, { title: options.title, kind: "error" });
  return true;
}
