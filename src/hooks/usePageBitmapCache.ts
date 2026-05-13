import { useEffect, useRef } from "react";

export interface PageBitmapEntry {
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

export interface PageBitmapInput {
  blob: Blob;
  width: number;
  height: number;
}

export interface PageBitmapCache {
  readonly size: number;
  get: (fileId: string, page: number, dpi: number) => PageBitmapEntry | null;
  set: (
    fileId: string,
    page: number,
    dpi: number,
    input: PageBitmapInput
  ) => PageBitmapEntry;
  delete: (fileId: string, page: number, dpi: number) => boolean;
  clear: () => void;
}

export const DEFAULT_PAGE_BITMAP_CACHE_CAPACITY = 12;

export function pageBitmapCacheKey(
  fileId: string,
  page: number,
  dpi: number
): string {
  return `${fileId}::${Math.max(1, Math.floor(page))}::${Math.max(
    1,
    Math.floor(dpi)
  )}`;
}

export function createPageBitmapCache(
  capacity = DEFAULT_PAGE_BITMAP_CACHE_CAPACITY
): PageBitmapCache {
  const maxEntries = Math.max(1, Math.floor(capacity));
  const entries = new Map<string, PageBitmapEntry>();

  const revoke = (entry: PageBitmapEntry) => {
    URL.revokeObjectURL(entry.url);
  };

  return {
    get size() {
      return entries.size;
    },
    get(fileId, page, dpi) {
      const key = pageBitmapCacheKey(fileId, page, dpi);
      const entry = entries.get(key);
      if (!entry) return null;

      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    set(fileId, page, dpi, input) {
      const key = pageBitmapCacheKey(fileId, page, dpi);
      const previous = entries.get(key);
      if (previous) {
        revoke(previous);
        entries.delete(key);
      }

      const entry: PageBitmapEntry = {
        blob: input.blob,
        url: URL.createObjectURL(input.blob),
        width: input.width,
        height: input.height,
      };
      entries.set(key, entry);

      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (!oldestKey) break;

        const oldest = entries.get(oldestKey);
        if (oldest) revoke(oldest);
        entries.delete(oldestKey);
      }

      return entry;
    },
    delete(fileId, page, dpi) {
      const key = pageBitmapCacheKey(fileId, page, dpi);
      const entry = entries.get(key);
      if (!entry) return false;

      revoke(entry);
      return entries.delete(key);
    },
    clear() {
      for (const entry of entries.values()) {
        revoke(entry);
      }
      entries.clear();
    },
  };
}

export function usePageBitmapCache(
  capacity = DEFAULT_PAGE_BITMAP_CACHE_CAPACITY
): PageBitmapCache {
  const cacheRef = useRef<PageBitmapCache | null>(null);
  if (!cacheRef.current) {
    cacheRef.current = createPageBitmapCache(capacity);
  }

  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      cache?.clear();
    };
  }, []);

  return cacheRef.current;
}
