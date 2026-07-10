export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return !!(w.__TAURI__ || w.__TAURI_INTERNALS__);
}

export async function logWarn(message: string): Promise<void> {
  if (isTauriRuntime()) {
    try {
      const mod = await import("@tauri-apps/plugin-log");
      await mod.warn(message);
      return;
    } catch {
      // Fall through to console for browser and degraded desktop cases.
    }
  }
  console.warn(message);
}

export async function logError(message: string): Promise<void> {
  if (isTauriRuntime()) {
    try {
      const mod = await import("@tauri-apps/plugin-log");
      await mod.error(message);
      return;
    } catch {
      // Fall through to console for browser and degraded desktop cases.
    }
  }
  console.error(message);
}

export async function copyText(text: string): Promise<void> {
  if (isTauriRuntime()) {
    const mod = await import("@tauri-apps/plugin-clipboard-manager");
    await mod.writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export interface SaveTextFileOptions {
  defaultName: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export async function saveTextFile(
  content: string,
  options: SaveTextFileOptions
): Promise<boolean> {
  if (isTauriRuntime()) {
    const [{ save }, { writeTextFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs"),
    ]);
    const target = await save({
      defaultPath: options.defaultName,
      filters: options.filters,
    });
    if (!target) return false;
    await writeTextFile(target, content);
    return true;
  }

  downloadBlob(
    new Blob([content], { type: "text/markdown;charset=utf-8" }),
    options.defaultName
  );
  return true;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
