import { useCallback, useEffect, useMemo, useRef } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { FileEntry, FileKind } from "@/lib/ipc-types";
import {
  getPdfInfo,
  listSupportedExtensions,
  loadRasterImage,
  renderPage,
} from "@/lib/tauri";
import { useStore } from "@/store";
import { usePageBitmapCacheContext } from "./PageBitmapCacheContext";
import { pngBase64ToBlob } from "./usePageBitmapCache";

const PDF_PREVIEW_DPI = 150;

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
  const cache = usePageBitmapCacheContext();

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
        const name = basename(path);
        const ext = extensionOf(name);
        const kind = classify(ext);
        try {
          const entry: FileEntry =
            kind === "pdf"
              ? await buildPdfEntry(path, name, ext)
              : await buildImageEntry(path, name, ext);
          addFile(entry);
          okCount += 1;
        } catch (err) {
          console.error(`${kind} import failed`, path, err);
          setStatusText(`加载失败 · ${name}`);
        }
      }

      async function buildImageEntry(
        path: string,
        name: string,
        ext: string
      ): Promise<FileEntry> {
        const payload = await loadRasterImage(path);
        return {
          id: makeId(),
          path,
          name,
          ext,
          kind: "image",
          payload,
        };
      }

      async function buildPdfEntry(
        path: string,
        name: string,
        ext: string
      ): Promise<FileEntry> {
        const info = await getPdfInfo(path);
        const pdfTotal = Math.max(1, info.page_count);
        const ipc = await renderPage({
          path,
          page: 1,
          dpi: PDF_PREVIEW_DPI,
          purpose: "preview",
        });

        const id = makeId();
        const blob = pngBase64ToBlob(ipc.png_base64);
        const entry = cache.set(id, 1, PDF_PREVIEW_DPI, {
          blob,
          width: ipc.width,
          height: ipc.height,
        });

        return {
          id,
          path,
          name,
          ext,
          kind: "pdf",
          payload: {
            width: ipc.width,
            height: ipc.height,
            png_base64: "",
            objectUrl: entry.url,
          },
          pdfTotal,
          currentPage: 1,
          payloadPage: 1,
        };
      }

      if (okCount > 0) {
        setStatusText(okCount === 1 ? "就绪" : `已加载 ${okCount} 个文件`);
      }
    },
    [addFile, cache, getSupported, setStatusText]
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
