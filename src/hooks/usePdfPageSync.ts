import { useEffect, useRef } from "react";
import { t } from "@/i18n";
import { loadRasterImage, renderPage } from "@/lib/tauri";
import { logError } from "@/lib/runtime";
import { appErrorMessage } from "@/lib/ipc-types";
import { useStore } from "@/store";
import { usePageBitmapCacheContext } from "./PageBitmapCacheContext";

const PDF_PREVIEW_DPI = 150;

/** Images are single-page; their bitmap shares the page LRU under page 1. */
const IMAGE_PAGE = 1;

/**
 * Mounts in AppShell. Keeps the active file's `payload.objectUrl` pointing at
 * a *live* blob URL — for PDFs, one matching `currentPage`; for images, the
 * single page-1 entry.
 *
 * Both kinds need this, not just PDFs. The bitmap LRU revokes an entry's
 * object URL when it evicts, so any file whose entry is dropped is left
 * holding a dead URL in the store; `useImage` then fails and the canvas
 * silently renders nothing. Images used to be excluded here, which also meant
 * they were never `cache.get`-promoted — so a displayed image sat permanently
 * at the tail of the LRU and was always the *first* thing evicted.
 *
 * Per-file tokens drop stale responses on fast navigation.
 */
export function usePdfPageSync(): void {
  const file = useStore((s) =>
    s.currentFileId ? s.files.find((f) => f.id === s.currentFileId) ?? null : null
  );
  const setFilePayload = useStore((s) => s.setFilePayload);
  const setStatusText = useStore((s) => s.setStatusText);
  const cache = usePageBitmapCacheContext();

  // Per-file token: bumped before each request. A response that doesn't match
  // the latest token for its file id is discarded.
  const requestTokens = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!file) return;
    // Import already tried this one and the backend explained why it can't be
    // decoded — a DNG with no embedded preview won't grow one. Re-firing the
    // same IPC on every activation would just burn a decode and overwrite the
    // stored reason the canvas is displaying.
    if (file.loadError) return;
    const isPdf = file.kind === "pdf";
    const targetPage = isPdf ? file.currentPage ?? 1 : IMAGE_PAGE;
    const fileId = file.id;
    const path = file.path;

    // Doubles as the LRU promotion for the file on screen.
    const cached = cache.get(fileId, targetPage, PDF_PREVIEW_DPI);

    if (cached) {
      // Already showing this exact bitmap — and the `get` above just renewed
      // its position in the LRU, which is the whole point of coming through
      // here on every activation.
      if (
        file.payload?.objectUrl === cached.url &&
        (!isPdf || file.payloadPage === targetPage)
      ) {
        return;
      }
      requestTokens.current.set(
        fileId,
        (requestTokens.current.get(fileId) ?? 0) + 1
      );
      setFilePayload(
        fileId,
        {
          width: cached.width,
          height: cached.height,
          objectUrl: cached.url,
        },
        targetPage
      );
      return;
    }

    // Cache miss. For PDFs that's either a page change or an eviction; for
    // images it can only be an eviction, and the stored objectUrl is now
    // revoked. Either way the fix is the same: fetch it again.
    const token = (requestTokens.current.get(fileId) ?? 0) + 1;
    requestTokens.current.set(fileId, token);

    let cancelled = false;
    void (async () => {
      try {
        const fetched = isPdf
          ? await renderPage({
              path,
              page: targetPage,
              dpi: PDF_PREVIEW_DPI,
              purpose: "preview",
            })
          : await loadRasterImage(path);
        if (cancelled) return;
        if (requestTokens.current.get(fileId) !== token) return;

        const entry = cache.set(fileId, targetPage, PDF_PREVIEW_DPI, {
          blob: fetched.blob,
          width: fetched.width,
          height: fetched.height,
        });

        setFilePayload(
          fileId,
          {
            width: fetched.width,
            height: fetched.height,
            objectUrl: entry.url,
          },
          targetPage
        );
      } catch (err) {
        if (cancelled) return;
        if (requestTokens.current.get(fileId) !== token) return;
        const message = appErrorMessage(err);
        void logError(
          isPdf
            ? `renderPage failed: ${path} page=${targetPage}: ${message}`
            : `loadRasterImage failed: ${path}: ${message}`
        );
        setStatusText(
          isPdf
            ? t("import.renderFailed", { page: targetPage })
            : t("import.loadFailed", { name: file.name })
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, cache, setFilePayload, setStatusText]);
}
