import type { StartJobInfo } from "@/store/jobSlice";

// The web/Docker runtime keeps `activeJob` purely in-memory. A page refresh
// (or the tab being suspended and reloaded) wipes it, but the OCR job the
// user started keeps running server-side — it doesn't know or care that its
// browser tab went away. Without this record, `handleDone` in AppShell has
// nothing to match the eventual `done` event against, so the result is
// silently discarded even though the server already paid for it (API
// quota, wall-clock time). `sessionStorage` (not `localStorage`) is
// deliberate: a job belongs to the tab that started it, and stale entries
// from a closed tab shouldn't resurrect themselves in a new one.
const STORAGE_KEY = "xcvt:pendingJob";

export function savePendingJob(info: StartJobInfo): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(info));
  } catch {
    // Storage unavailable (private browsing, quota) — reconciliation on
    // refresh just won't be possible; the live event stream still works.
  }
}

export function loadPendingJob(): StartJobInfo | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StartJobInfo;
  } catch {
    return null;
  }
}

export function clearPendingJob(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do — best-effort cleanup.
  }
}
