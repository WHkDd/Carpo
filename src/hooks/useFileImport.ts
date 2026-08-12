import { useCallback, useEffect, useMemo, useRef } from "react";
import type { FileEntry, FileKind } from "@/lib/ipc-types";
import { appErrorMessage } from "@/lib/ipc-types";
import { isTauriRuntime, logError } from "@/lib/runtime";
import {
  getPdfInfo,
  importClipboardImage,
  listSupportedExtensions,
  loadRasterImage,
  renderPage,
  uploadFile,
} from "@/lib/tauri";
import { useStore } from "@/store";
import { t } from "@/i18n";
import { usePageBitmapCacheContext } from "./PageBitmapCacheContext";

const PDF_PREVIEW_DPI = 150;
const BROWSER_ACCEPT = ".png,.jpg,.jpeg,.tif,.tiff,.bmp,.dng,.pdf";

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

export function partitionBySupportedExtension<T>(
  items: T[],
  nameOf: (item: T) => string,
  supported: string[]
): { accepted: T[]; rejected: T[] } {
  const supportedSet = new Set(supported.map((ext) => ext.toLowerCase()));
  const accepted: T[] = [];
  const rejected: T[] = [];
  for (const item of items) {
    (supportedSet.has(extensionOf(nameOf(item))) ? accepted : rejected).push(item);
  }
  return { accepted, rejected };
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Explains what was thrown away, so a drop that half-worked doesn't look
 *  like a drop that silently half-failed. Names the first rejected extension
 *  because in practice a mixed drop is one stray format, not five. */
function rejectionMessage(rejected: string[], acceptedCount: number): string {
  const ext = extensionOf(rejected[0]!);
  const params = {
    count: rejected.length,
    ext: ext.length > 0 ? `.${ext}` : t("import.noExtension"),
  };
  return acceptedCount > 0
    ? t("import.rejectedSome", params)
    : t("import.rejectedAll", params);
}

export function useFileImport() {
  const addFile = useStore((s) => s.addFile);
  const setStatusText = useStore((s) => s.setStatusText);
  const setDropTargetActive = useStore((s) => s.setDropTargetActive);
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
      const { accepted, rejected } = partitionBySupportedExtension(
        paths,
        (path) => path,
        supported
      );
      // Filtering used to be silent in both directions: drop five files with
      // two `.docx` among them and three appeared with no explanation for the
      // rest; drop only unsupported files and absolutely nothing happened,
      // which reads as a frozen app.
      if (accepted.length === 0) {
        if (rejected.length > 0) setStatusText(rejectionMessage(rejected, 0));
        return;
      }

      setStatusText(
        accepted.length === 1
          ? t("import.loadingOne", { name: basename(accepted[0]!) })
          : t("import.loadingMany", { count: accepted.length })
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
          setStatusText(t("import.loadFailed", { name }));
          // Queue it anyway, carrying the reason. Dropping the entry here used
          // to make a failed import indistinguishable from one that never
          // happened: `statusText` is written but rendered nowhere, so the file
          // simply didn't appear and the backend's explanation reached the log
          // file only. Selecting the entry now shows that explanation.
          addFile({ id: makeId(), path, name, ext, kind, loadError: message });
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

      // Rejections outrank the success line: the successes are visible in the
      // queue, the rejections are only visible here.
      if (rejected.length > 0) {
        setStatusText(rejectionMessage(rejected, accepted.length));
      } else if (okCount > 0) {
        setStatusText(
          okCount === 1
            ? t("common.ready")
            : t("import.loadedMany", { count: okCount })
        );
      }
    },
    [addFile, cache, getSupported, setStatusText]
  );

  const importFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const supported = await getSupported();
      const { accepted, rejected } = partitionBySupportedExtension(
        files,
        (file) => file.name,
        supported
      );
      if (accepted.length === 0) {
        if (rejected.length > 0) {
          setStatusText(rejectionMessage(rejected.map((file) => file.name), 0));
        }
        return;
      }

      setStatusText(
        accepted.length === 1
          ? t("import.uploadingOne", { name: accepted[0]!.name })
          : t("import.uploadingMany", { count: accepted.length })
      );

      let okCount = 0;
      for (const file of accepted) {
        const ext = extensionOf(file.name);
        const kind = classify(ext);
        // Tracked outside the try so a preview failure after a successful
        // upload can still point the queue entry at the uploaded file.
        let fileId: string | null = null;
        try {
          const uploaded = await uploadFile(file);
          fileId = uploaded.fileId;
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
          setStatusText(t("import.uploadFailed", { name: file.name }));
          // Same reasoning as the desktop path: surface the failure in the
          // queue rather than dropping it silently.
          addFile({
            id: fileId ?? makeId(),
            path: fileId ?? "",
            name: file.name,
            ext,
            kind,
            loadError: message,
          });
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

      if (rejected.length > 0) {
        setStatusText(
          rejectionMessage(
            rejected.map((file) => file.name),
            accepted.length
          )
        );
      } else if (okCount > 0) {
        setStatusText(
          okCount === 1
            ? t("common.ready")
            : t("import.loadedMany", { count: okCount })
        );
      }
    },
    [addFile, cache, getSupported, setStatusText]
  );

  const openFiles = useCallback(async () => {
    if (!isTauriRuntime()) {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = BROWSER_ACCEPT;
      input.style.display = "none";
      input.onchange = () => {
        const files = Array.from(input.files ?? []);
        input.remove();
        void importFiles(files);
      };
      document.body.appendChild(input);
      input.click();
      window.setTimeout(() => input.remove(), 60_000);
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

  // Guards against a second paste starting while the first is still writing
  // its PNG. Independent pastes are meant to produce independent queue items,
  // so this only collapses the overlapping case (key repeat, double-tap).
  const pastingRef = useRef(false);

  const pasteClipboardImage = useCallback(async () => {
    if (!isTauriRuntime()) return;
    if (pastingRef.current) return;
    pastingRef.current = true;
    try {
      const imported = await importClipboardImage();
      // No image on the clipboard — the common case for ⌘V. Stay silent.
      if (!imported) return;
      // Straight into the normal path-import chain: preview caching, entry
      // construction and error handling all stay in one place, and the OCR
      // pipeline gets a real file to re-read.
      await importPaths([imported.path]);
    } catch (err) {
      const message = appErrorMessage(err);
      void logError(`clipboard image import failed: ${message}`);
      setStatusText(t("import.clipboardFailed", { message }));
    } finally {
      pastingRef.current = false;
    }
  }, [importPaths, setStatusText]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      let dragDepth = 0;
      const onDragEnter = (event: DragEvent) => {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        dragDepth += 1;
        setDropTargetActive(true);
      };
      const onDragOver = (event: DragEvent) => {
        if (event.dataTransfer?.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      };
      const onDragLeave = (event: DragEvent) => {
        if (!event.dataTransfer?.types.includes("Files")) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0 || event.relatedTarget === null) {
          dragDepth = 0;
          setDropTargetActive(false);
        }
      };
      const onDrop = (event: DragEvent) => {
        if (!event.dataTransfer?.files.length) return;
        event.preventDefault();
        dragDepth = 0;
        setDropTargetActive(false);
        void importFiles(Array.from(event.dataTransfer.files));
      };
      const clearDragState = () => {
        dragDepth = 0;
        setDropTargetActive(false);
      };
      window.addEventListener("dragenter", onDragEnter);
      window.addEventListener("dragover", onDragOver);
      window.addEventListener("dragleave", onDragLeave);
      window.addEventListener("drop", onDrop);
      window.addEventListener("blur", clearDragState);
      return () => {
        window.removeEventListener("dragenter", onDragEnter);
        window.removeEventListener("dragover", onDragOver);
        window.removeEventListener("dragleave", onDragLeave);
        window.removeEventListener("drop", onDrop);
        window.removeEventListener("blur", clearDragState);
        clearDragState();
      };
    }

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const fn = await getCurrentWebview().onDragDropEvent((event) => {
        switch (event.payload.type) {
          case "enter":
          case "over":
            setDropTargetActive(true);
            break;
          case "drop":
            // Clear unconditionally and *before* the await: if the import
            // throws, the overlay must still come down.
            setDropTargetActive(false);
            void importPaths(event.payload.paths);
            break;
          default:
            // "leave" — and the same event fires when the pointer exits the
            // window entirely, which is the path that would otherwise leave
            // the overlay stuck on screen forever.
            setDropTargetActive(false);
            break;
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
      setDropTargetActive(false);
      if (unlisten) unlisten();
    };
  }, [importFiles, importPaths, setDropTargetActive]);

  return useMemo(
    () => ({ openFiles, importPaths, importFiles, pasteClipboardImage }),
    [openFiles, importPaths, importFiles, pasteClipboardImage]
  );
}
