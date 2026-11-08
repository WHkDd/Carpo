import type { FileEntry } from "@/lib/ipc-types";
import { saveTextFile } from "@/lib/runtime";
import { pathsExist } from "@/lib/tauri";
import { t } from "@/i18n";
import { useStore, type AppStore } from "@/store";
import { pageKeyFileId } from "@/store/pageStateSlice";
import { SNAPSHOT_FILE_MAPS } from "@/store/queueSlice";

/**
 * Progress snapshot (进度快照): the queue plus every piece of per-file work —
 * boxes, articles, metadata, OCR results and proofread reviews — written to
 * one JSON file so a half-finished session can be picked up after a restart.
 *
 * Deliberately light: it records each source file's *path*, never its pixels,
 * so restoring needs the originals to still be where they were. Desktop only:
 * the Web build's upload ids do not survive a server restart.
 *
 * Left out on purpose: previews (rebuilt on demand), zoom / selection /
 * editing state, running jobs, settings and keys.
 */

const APP_TAG = "carpo-progress";
const VERSION = 1;

type FileMapKey = (typeof SNAPSHOT_FILE_MAPS)[number];

/** `loadError` is dropped too: it describes this run's attempt, and a file
 *  that was missing then may be back in place by the time of the restore. */
export type SnapshotFile = Omit<FileEntry, "payload" | "payloadPage" | "loadError">;

export type SessionSnapshot = {
  app: typeof APP_TAG;
  version: typeof VERSION;
  savedAt: string;
  currentFileId: string | null;
  files: SnapshotFile[];
  pageStates: AppStore["pageStates"];
} & Pick<AppStore, FileMapKey>;

/** What `restoreSnapshot` takes: a parsed snapshot whose files may carry a
 *  fresh `loadError` (original no longer on disk). */
export type RestorableSnapshot = Omit<SessionSnapshot, "files"> & {
  files: FileEntry[];
};

export function buildSnapshot(state: AppStore): SessionSnapshot {
  const ids = new Set(state.files.map((file) => file.id));
  const pick = <V>(map: Record<string, V>, idOf = (key: string) => key) =>
    Object.fromEntries(Object.entries(map).filter(([key]) => ids.has(idOf(key))));
  const maps = Object.fromEntries(
    SNAPSHOT_FILE_MAPS.map((key) => [key, pick<unknown>(state[key])])
  ) as unknown as Pick<AppStore, FileMapKey>;
  return {
    app: APP_TAG,
    version: VERSION,
    savedAt: new Date().toISOString(),
    currentFileId: state.currentFileId,
    files: state.files.map(
      ({ payload: _payload, payloadPage: _page, loadError: _error, ...rest }) => rest
    ),
    pageStates: pick(state.pageStates, pageKeyFileId),
    ...maps,
  };
}

/** Shape check only — enough to reject an unrelated JSON file with a clear
 *  message. Missing maps are tolerated and read as empty. */
export function parseSnapshot(text: string): SessionSnapshot {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(t("snapshot.invalid"));
  }
  if (
    typeof data !== "object" ||
    data === null ||
    (data as { app?: unknown }).app !== APP_TAG ||
    !Array.isArray((data as { files?: unknown }).files)
  ) {
    throw new Error(t("snapshot.invalid"));
  }
  const version = (data as { version?: unknown }).version;
  if (version !== VERSION) {
    throw new Error(t("snapshot.unsupportedVersion", { version: String(version) }));
  }
  return data as SessionSnapshot;
}

const FILE_FILTERS = () => [{ name: t("snapshot.fileFilter"), extensions: ["json"] }];

/** Returns the number of files saved, or null when the user cancelled. */
export async function saveProgressSnapshot(): Promise<number | null> {
  const snapshot = buildSnapshot(useStore.getState());
  const date = snapshot.savedAt.slice(0, 10);
  const saved = await saveTextFile(JSON.stringify(snapshot), {
    defaultName: `carpo-progress-${date}.json`,
    filters: FILE_FILTERS(),
  });
  return saved ? snapshot.files.length : null;
}

export interface RestoreSummary {
  added: number;
  skipped: number;
  missing: number;
}

/** Returns null when the user cancelled the file picker. Throws on an
 *  unreadable or foreign file. */
export async function openProgressSnapshot(): Promise<RestoreSummary | null> {
  const [{ open }, { readTextFile }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
  ]);
  const path = await open({ multiple: false, directory: false, filters: FILE_FILTERS() });
  if (typeof path !== "string") return null;

  const snapshot = parseSnapshot(await readTextFile(path));
  const queued = new Set(useStore.getState().files.map((file) => file.id));
  const exists = await pathsExist(snapshot.files.map((file) => file.path));
  let missing = 0;
  const files: FileEntry[] = snapshot.files.map((file, index) => {
    if (exists[index] || queued.has(file.id)) return file;
    missing += 1;
    return { ...file, loadError: t("snapshot.fileMissing", { path: file.path }) };
  });

  const { added, skipped } = useStore.getState().restoreSnapshot({ ...snapshot, files });
  return { added, skipped, missing };
}
