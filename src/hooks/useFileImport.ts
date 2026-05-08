import { useCallback, useEffect, useMemo, useRef } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { FileEntry, FileKind } from "@/lib/ipc-types";
import { listSupportedExtensions, loadRasterImage } from "@/lib/tauri";
import { useStore } from "@/store";

function basename(p: string): string {
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return slash >= 0 ? p.slice(slash + 1) : p;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function classify(ext: string): FileKind {
  return ext === "pdf" ? "pdf" : "image";
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useFileImport() {
  const addFile = useStore((s) => s.addFile);
  const setStatusText = useStore((s) => s.setStatusText);

  const supportedRef = useRef<string[] | null>(null);

  const getSupported = useCallback(async (): Promise<string[]> => {
    if (supportedRef.current) return supportedRef.current;
    const exts = await listSupportedExtensions();
    supportedRef.current = exts;
    return exts;
  }, []);

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      const supported = await getSupported();
      const accepted = paths.filter((p) => supported.includes(extensionOf(p)));
      if (accepted.length === 0) return;

      setStatusText(
        accepted.length === 1
          ? `正在加载 ${basename(accepted[0]!)}`
          : `正在加载 ${accepted.length} 个文件`
      );

      let okCount = 0;
      for (const path of accepted) {
        try {
          const payload = await loadRasterImage(path);
          const name = basename(path);
          const ext = extensionOf(name);
          const entry: FileEntry = {
            id: makeId(),
            path,
            name,
            ext,
            kind: classify(ext),
            payload,
          };
          addFile(entry);
          okCount += 1;
        } catch (err) {
          console.error("loadRasterImage failed", path, err);
          setStatusText(`加载失败 · ${basename(path)}`);
        }
      }

      if (okCount > 0) {
        setStatusText(okCount === 1 ? "就绪" : `已加载 ${okCount} 个文件`);
      }
    },
    [addFile, getSupported, setStatusText]
  );

  const openFiles = useCallback(async () => {
    const supported = await getSupported();
    const selection = await openDialog({
      multiple: true,
      filters: [{ name: "Images", extensions: supported }],
    });
    if (!selection) return;
    const paths = Array.isArray(selection) ? selection : [selection];
    await importPaths(paths);
  }, [getSupported, importPaths]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const fn = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          void importPaths(event.payload.paths);
        }
      });
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [importPaths]);

  return useMemo(() => ({ openFiles, importPaths }), [openFiles, importPaths]);
}
