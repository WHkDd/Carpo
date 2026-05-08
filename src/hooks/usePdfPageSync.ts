import { useEffect, useRef } from "react";
import { renderPage } from "@/lib/tauri";
import { useStore } from "@/store";
import { usePageBitmapCacheContext } from "./PageBitmapCacheContext";
import { pngBase64ToBlob } from "./usePageBitmapCache";

const PDF_PREVIEW_DPI = 150;

/**
 * Mounts in AppShell. Whenever the active PDF's currentPage drifts away from
 * the page its `payload` was rendered for, either reuses a cached bitmap or
 * fires an IPC render. Per-file tokens drop stale responses on fast nav.
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
    if (!file || file.kind !== "pdf") return;
    const targetPage = file.currentPage ?? 1;
    const fileId = file.id;
    const path = file.path;

    const cached = cache.get(fileId, targetPage, PDF_PREVIEW_DPI);

    // payloadPage matching currentPage normally means "nothing to do", but if
    // the cache evicted this file's entry while it was offstage the stored
    // objectUrl is now revoked. Detect that and fall through to re-render.
    if (
      file.payloadPage === targetPage &&
      (cached !== null || !file.payload?.objectUrl)
    ) {
      return;
    }

    if (cached) {
      // Bump the token so any in-flight IPC for this file is invalidated by the
      // synchronous cache hit — keeps stale responses from clobbering the page
      // the user just snapped to.
      requestTokens.current.set(
        fileId,
        (requestTokens.current.get(fileId) ?? 0) + 1
      );
      setFilePayload(
        fileId,
        {
          width: cached.width,
          height: cached.height,
          png_base64: "",
          objectUrl: cached.url,
        },
        targetPage
      );
      return;
    }

    const token = (requestTokens.current.get(fileId) ?? 0) + 1;
    requestTokens.current.set(fileId, token);

    let cancelled = false;
    void (async () => {
      try {
        const payload = await renderPage({
          path,
          page: targetPage,
          dpi: PDF_PREVIEW_DPI,
          purpose: "preview",
        });
        if (cancelled) return;
        if (requestTokens.current.get(fileId) !== token) return;

        const blob = pngBase64ToBlob(payload.png_base64);
        const entry = cache.set(fileId, targetPage, PDF_PREVIEW_DPI, {
          blob,
          width: payload.width,
          height: payload.height,
        });

        setFilePayload(
          fileId,
          {
            width: payload.width,
            height: payload.height,
            png_base64: "",
            objectUrl: entry.url,
          },
          targetPage
        );
      } catch (err) {
        if (cancelled) return;
        if (requestTokens.current.get(fileId) !== token) return;
        console.error("renderPage failed", { path, page: targetPage }, err);
        setStatusText(`渲染失败 · 第 ${targetPage} 页`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, cache, setFilePayload, setStatusText]);
}
