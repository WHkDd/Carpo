import type { FileEntry } from "./ipc-types";
import type { DocumentState } from "@/store/pageStateSlice";
import { parseSortDate } from "./batch-export";
import { t } from "@/i18n";
import { manualQueueFiles } from "@/store/queueSlice";

export type QueueSortField = "manual" | "date" | "name" | "newspaper";
export type QueueGroupMode = "none" | "newspaper" | "tag" | "year";
export interface QueueView {
  queueSortField: QueueSortField;
  queueSortAscending: boolean;
  queueGroupMode: QueueGroupMode;
  queueSearchText: string;
}
export interface QueueSection {
  id: string;
  title: string | null;
  files: FileEntry[];
}
const collator = new Intl.Collator("zh-Hans-CN", { numeric: true });

export function sortQueueFiles(
  files: FileEntry[],
  documents: Record<string, DocumentState>,
  manualOrder: string[],
  field: QueueSortField,
  ascending: boolean,
): FileEntry[] {
  if (field === "manual") return manualQueueFiles(files, manualOrder);
  const positions = new Map(files.map((file, index) => [file.id, index]));
  const metadata = new Map(
    files.map((file) => {
      const doc = documents[file.id];
      return [
        file.id,
        {
          paper: doc?.newspaperName.trim() ?? "",
          date: parseSortDate(doc?.newspaperDate ?? ""),
        },
      ];
    }),
  );
  const direction = ascending ? 1 : -1;
  const compareDate = (a: FileEntry, b: FileEntry, dir: number) => {
    const x = metadata.get(a.id)!.date,
      y = metadata.get(b.id)!.date;
    if (!x || !y) return Number(!x) - Number(!y);
    return (
      dir *
      (x.year - y.year ||
        (x.month ?? 0) - (y.month ?? 0) ||
        (x.day ?? 0) - (y.day ?? 0))
    );
  };
  return [...files].sort((a, b) => {
    const star = Number(!!b.isStarred) - Number(!!a.isStarred);
    if (star) return star;
    const fallback = positions.get(a.id)! - positions.get(b.id)!;
    const name = collator.compare(a.name, b.name);
    if (field === "name") return direction * name || fallback;
    if (field === "date")
      return compareDate(a, b, direction) || name || fallback;
    const x = metadata.get(a.id)!.paper,
      y = metadata.get(b.id)!.paper;
    return (
      Number(!x) - Number(!y) ||
      direction * collator.compare(x, y) ||
      compareDate(a, b, 1) ||
      name ||
      fallback
    );
  });
}

/** Input is already filtered and sorted. Grouping never changes its order. */
export function groupQueueFiles(
  files: FileEntry[],
  documents: Record<string, DocumentState>,
  mode: QueueGroupMode,
): QueueSection[] {
  if (mode === "none")
    return files.length ? [{ id: "all", title: null, files }] : [];
  const groups = new Map<string, QueueSection>();
  const missing: FileEntry[] = [];
  for (const file of files) {
    const doc = documents[file.id];
    let labels: string[];
    if (mode === "tag")
      labels = [
        ...new Set((doc?.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
      ];
    else if (mode === "newspaper")
      labels = [doc?.newspaperName.trim() ?? ""].filter(Boolean);
    else {
      const date = parseSortDate(doc?.newspaperDate ?? "");
      labels = date ? [String(date.year)] : [];
    }
    if (!labels.length) missing.push(file);
    for (const label of labels) {
      let group = groups.get(label);
      if (!group) {
        group = {
          id: `${mode}:${label}`,
          title: mode === "year" ? t("queue.year", { year: label }) : label,
          files: [],
        };
        groups.set(label, group);
      }
      group.files.push(file);
    }
  }
  const sections: QueueSection[] = [];
  const starred = files.filter((file) => file.isStarred);
  if (starred.length)
    sections.push({ id: "starred", title: t("queue.starred"), files: starred });
  sections.push(
    ...[...groups.entries()]
      .sort(([a], [b]) => collator.compare(a, b))
      .map(([, group]) => group),
  );
  if (missing.length)
    sections.push({
      id: `${mode}:empty`,
      title: t(
        mode === "tag"
          ? "queue.untagged"
          : mode === "year"
            ? "queue.undated"
            : "queue.unnamedPaper",
      ),
      files: missing,
    });
  return sections;
}
