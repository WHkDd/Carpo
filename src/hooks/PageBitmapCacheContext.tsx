import { createContext, useContext, type ReactNode } from "react";
import {
  usePageBitmapCache,
  type PageBitmapCache,
} from "./usePageBitmapCache";

const PageBitmapCacheContext = createContext<PageBitmapCache | null>(null);

/**
 * Owns the singleton bitmap cache for the lifetime of the app shell.
 *
 * Lives at the AppShell level — never unmounts during a normal session — so
 * that consumers (`useFileImport`, `usePdfPageSync`, `ImageCanvas`) share one
 * LRU and one set of objectURLs. Putting this in Zustand would make immer try
 * to proxy Blobs and break revoke-on-evict; a module-level singleton would
 * lose React's mount/unmount hook for `clear()`. This is the middle path.
 */
export function PageBitmapCacheProvider({ children }: { children: ReactNode }) {
  const cache = usePageBitmapCache();
  return (
    <PageBitmapCacheContext.Provider value={cache}>
      {children}
    </PageBitmapCacheContext.Provider>
  );
}

export function usePageBitmapCacheContext(): PageBitmapCache {
  const cache = useContext(PageBitmapCacheContext);
  if (!cache) {
    throw new Error(
      "usePageBitmapCacheContext must be used inside <PageBitmapCacheProvider>"
    );
  }
  return cache;
}
