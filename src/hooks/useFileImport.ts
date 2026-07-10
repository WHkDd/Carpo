import { useCallback, useEffect, useMemo, useRef } from "react";
import type { FileEntry, FileKind } from "@/lib/ipc-types";
import { appErrorMessage } from "@/lib/ipc-types";
import { isTauriRuntime, logError } from "@/lib/runtime";
import {
  getPdfInfo,
  listSupportedExtensions,
  loadRasterImage,
  renderPage,
  uploadFile,
} from "@/lib/tauri";
import { useStore } from "@/store";
import { usePageBitmapCacheContext } from "./PageBitmapCacheContext";

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
          const message = appErrorMessage(err);
          void logError(`${kind} import failed: ${path}: ${message}`);
          setStatusText(`加载失败 · ${name}`);
        }
      }

      async function buildImageEntry(
        path: string,
        name: string,
        ext: string
      ): Promise<FileEntry> {
        const fetched = await loadRasterImage(path);
        const id = makeId();
        const entry = cache.set(id, 1, PDF_PREVIEW_DPI, {
          blob: fetched.blob,
          width: fetched.width,
          height: fetched.height,
        });
        return {
          id,
          path,
          name,
          ext,
          kind: "image",
          payload: {
            width: fetched.width,
            height: fetched.height,
            objectUrl: entry.url,
          },
        };
      }

      async function buildPdfEntry(
        path: string,
        name: string,
        ext: string
      ): Promise<FileEntry> {
        const info = await getPdfInfo(path);
        const pdfTotal = Math.max(1, info.page_count);
        const fetched = await renderPage({
          path,
          page: 1,
          dpi: PDF_PREVIEW_DPI,
          purpose: "preview",
        });

        const id = makeId();
        const entry = cache.set(id, 1, PDF_PREVIEW_DPI, {
          blob: fetched.blob,
          width: fetched.width,
          height: fetched.height,
        });

        return {
          id,
          path,
          name,
          ext,
          kind: "pdf",
          payload: {
            width: fetched.width,
            height: fetched.height,
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

  const importFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const supported = await getSupported();
      const accepted = files.filter((file) =>
        supported.includes(extensionOf(file.name))
      );
      if (accepted.length === 0) return;

      setStatusText(
        accepted.length === 1
          ? `正在上传 ${accepted[0]!.name}`
          : `正在上传 ${accepted.length} 个文件`
      );

      let okCount = 0;
      for (const file of accepted) {
        const ext = extensionOf(file.name);
        const kind = classify(ext);
        try {
          const uploaded = await uploadFile(file);
          const entry: FileEntry =
            uploaded.kind === "pdf"
              ? await buildBrowserPdfEntry(uploaded.fileId, uploaded.name, uploaded.ext)
              : await buildBrowserImageEntry(
                  uploaded.fileId,
                  uploaded.name,
                  uploaded.ext
                );
          addFile(entry);
          okCount += 1;
        } catch (err) {
          const message = appErrorMessage(err);
          void logError(`${kind} upload failed: ${file.name}: ${message}`);
          setStatusText(`上传失败 · ${file.name}`);
        }
      }

      async function buildBrowserImageEntry(
        fileId: string,
        name: string,
        ext: string
      ): Promise<FileEntry> {
        const fetched = await loadRasterImage(fileId);
        const entry = cache.set(fileId, 1, PDF_PREVIEW_DPI, {
          blob: fetched.blob,
          width: fetched.width,
          height: fetched.height,
        });
        return {
          id: fileId,
          path: fileId,
          name,
          ext,
          kind: "image",
          payload: {
            width: fetched.width,
            height: fetched.height,
            objectUrl: entry.url,
          },
        };
      }

      async function buildBrowserPdfEntry(
        fileId: string,
        name: string,
        ext: string
      ): Promise<FileEntry> {
        const info = await getPdfInfo(fileId);
        const pdfTotal = Math.max(1, info.page_count);
        const fetched = await renderPage({
          path: fileId,
          page: 1,
          dpi: PDF_PREVIEW_DPI,
          purpose: "preview",
        });
        const entry = cache.set(fileId, 1, PDF_PREVIEW_DPI, {
          blob: fetched.blob,
          width: fetched.width,
          height: fetched.height,
        });
        return {
          id: fileId,
          path: fileId,
          name,
          ext,
          kind: "pdf",
          payload: {
            width: fetched.width,
            height: fetched.height,
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
    if (!isTauriRuntime()) {
      const supported = await getSupported();
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = supported.map((ext) => `.${ext}`).join(",");
      input.onchange = () => {
        void importFiles(Array.from(input.files ?? []));
      };
      input.click();
      return;
    }
    const supported = await getSupported();
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const selection = await openDialog({
      multiple: true,
      filters: [{ name: "Images", extensions: supported }],
    });
    if (!selection) return;
    const paths = Array.isArray(selection) ? selection : [selection];
    await importPaths(paths);
  }, [getSupported, importFiles, importPaths]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      const onDragOver = (event: DragEvent) => {
        if (event.dataTransfer?.types.includes("Files")) {
          event.preventDefault();
        }
      };
      const onDrop = (event: DragEvent) => {
        if (!event.dataTransfer?.files.length) return;
        event.preventDefault();
        void importFiles(Array.from(event.dataTransfer.files));
      };
      window.addEventListener("dragover", onDragOver);
      window.addEventListener("drop", onDrop);
      return () => {
        window.removeEventListener("dragover", onDragOver);
        window.removeEventListener("drop", onDrop);
      };
    }

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
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
  }, [importFiles, importPaths]);

  return useMemo(
    () => ({ openFiles, importPaths, importFiles }),
    [openFiles, importPaths, importFiles]
  );
}
