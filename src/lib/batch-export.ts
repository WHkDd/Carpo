/**
 * Background batch OCR + export (批量识别导出).
 *
 * Each selected file is planned once, at start: a file with at least one
 * article that has blocks runs grouped OCR over those articles (框选识别);
 * any other file runs whole-file OCR over its page range (全文识别). Files
 * are processed one at a time, and only units without a usable result are
 * sent — an article / page that already has text is reused.
 *
 * The runner is a module-level async loop, not a hook: it has to outlive the
 * dialog that started it. It never touches `activeJob` or the foreground
 * start claim, so the user keeps working while it runs; its only footprint
 * in the store is `batchExport`, plus the per-file results it writes back
 * through the same writers the foreground job handler uses. Job events reach
 * it through `routeBatchJobEvent`, which `AppShell` calls before its own
 * handlers.
 */
import { getLanguage, t } from "@/i18n";
import { en, zh } from "@/i18n/messages";
import { useStore, type AppStore } from "@/store";
import type {
  BatchExportFormat,
  BatchExportItem,
  BatchExportLayout,
  BatchExportState,
  BatchFileMode,
} from "@/store/jobSlice";
import { articleRegionKey, buildArticlePlans } from "@/hooks/useGroupedOcrTrigger";
import { assembleDocument } from "@/lib/format-doc";
import { ACTIVE_PREVIEW_DPI, providerSetupError } from "@/lib/ocr-profile";
import { PageRangeError, parsePageRangePlan } from "@/lib/page-range";
import { cancelJob, startGroupedOcr, startWholeFileOcr } from "@/lib/tauri";
import { enableNotificationsAfterUserAction, notifyOcrResult } from "@/lib/desktop";
import { downloadBlob, isTauriRuntime, logWarn } from "@/lib/runtime";
import {
  appErrorMessage,
  type ArticleOcrPlan,
  type GroupedJobDone,
  type JobDone,
  type JobError,
  type JobProgress,
  type WholeFileJobDone,
} from "@/lib/ipc-types";
import {
  buildDocx,
  DOCX_MIME,
  markdownToDocBlocks,
  type DocBlock,
} from "@/lib/docx";

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface BatchFilePlan {
  fileId: string;
  name: string;
  mode: BatchFileMode;
  /** Grouped: every article that has blocks, rects snapshotted at start. */
  articles: ArticleOcrPlan[];
  /** Whole-file: the pages of the file's range. */
  pages: number[];
  /** Set when the file cannot be processed at all. */
  error?: string;
}

type PlanState = Pick<
  AppStore,
  "files" | "pageStates" | "wholeFileRange" | "getDocumentState"
>;

export function planBatchFile(state: PlanState, fileId: string): BatchFilePlan {
  const file = state.files.find((f) => f.id === fileId);
  const name = file?.name ?? t("common.untitledFile");
  const docState = state.getDocumentState(fileId);
  const withBlocks = new Set(
    docState.articles.filter((a) => a.blockRefs.length > 0).map((a) => a.id)
  );
  const mode: BatchFileMode = withBlocks.size > 0 ? "grouped" : "whole_file";
  const base = { fileId, name, mode, articles: [], pages: [] };
  if (!file) return { ...base, error: t("batch.removed") };
  if (file.loadError) return { ...base, error: file.loadError };

  if (mode === "grouped") {
    const plans = buildArticlePlans(fileId, docState, state.pageStates, (id) =>
      withBlocks.has(id)
    );
    if ("error" in plans) return { ...base, error: plans.error };
    return { ...base, articles: plans.articles };
  }

  const totalPages = file.kind === "pdf" ? Math.max(1, file.pdfTotal ?? 1) : 1;
  try {
    const range = file.kind === "pdf" ? state.wholeFileRange[fileId] ?? "" : "";
    return { ...base, pages: parsePageRangePlan(range, totalPages).pages };
  } catch (e) {
    return {
      ...base,
      error: e instanceof PageRangeError ? e.message : appErrorMessage(e),
    };
  }
}

/** Whether a stored article text is one of the failure markers the job
 *  handler writes, in either UI language (the language may have changed
 *  since). Such an article counts as missing and is retried. */
export function isOcrFailureText(text: string): boolean {
  for (const catalog of [zh, en]) {
    const failedPrefix = catalog["job.recognizeFailed"].split("{message}")[0]!;
    if (text.startsWith(failedPrefix)) return true;
    if (text === catalog["job.notRecognized"]) return true;
  }
  return false;
}

/** The part of a plan that still needs OCR, judged against the live store.
 *  An article counts as missing when it has no text, only a failure marker,
 *  or text recognized from boxes that have since been moved, resized or
 *  re-ordered — even if the user edited that text since: the boxes changing
 *  says the old region was wrong. */
export function missingUnits(
  state: Pick<AppStore, "articleOcrTexts" | "articleOcrRegions" | "recognizedPages">,
  plan: BatchFilePlan
): { articles: ArticleOcrPlan[]; pages: number[] } {
  if (plan.mode === "grouped") {
    const texts = state.articleOcrTexts[plan.fileId] ?? {};
    const regions = state.articleOcrRegions[plan.fileId] ?? {};
    return {
      articles: plan.articles.filter((a) => {
        const text = texts[a.id];
        if (!text || isOcrFailureText(text)) return true;
        // No recorded region: nothing to compare against, keep the text.
        const region = regions[a.id];
        return region !== undefined && region !== articleRegionKey(a);
      }),
      pages: [],
    };
  }
  const pages = state.recognizedPages[plan.fileId] ?? {};
  return {
    articles: [],
    pages: plan.pages.filter((p) => pages[p]?.status !== "done"),
  };
}

// ---------------------------------------------------------------------------
// Ordering (排序)
// ---------------------------------------------------------------------------

/** A Gregorian date, as precise as the user wrote it. */
export interface SortDate {
  year: number;
  month?: number;
  day?: number;
}

const DASHED = /^(\d{4})(?:([-./])(\d{1,2})(?:\2(\d{1,2}))?)?$/;
const CJK = /^(\d{4})年(?:(\d{1,2})月(?:(\d{1,2})日)?)?$/;

/** Parses the metadata date for sorting only. Accepts 1936-05-12,
 *  1936.5.12, 1936/5/12, 1936年5月12日, and the year / year-month prefixes
 *  of each; spaces and full-width digits are tolerated. Republican-era
 *  (民国) years are not recognized. Returns null for empty or unparseable
 *  input, including impossible dates such as 1936-02-30. */
export function parseSortDate(raw: string): SortDate | null {
  const text = raw
    .replace(/[０-９－．／]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    )
    .replace(/\s+/g, "");
  if (!text) return null;
  const dashed = DASHED.exec(text);
  const cjk = dashed ? null : CJK.exec(text);
  const parts = dashed
    ? [dashed[1], dashed[3], dashed[4]]
    : cjk
      ? [cjk[1], cjk[2], cjk[3]]
      : null;
  if (!parts) return null;
  const [year, month, day] = parts.map((p) => (p === undefined ? undefined : Number(p)));
  if (month !== undefined && (month < 1 || month > 12)) return null;
  if (day !== undefined) {
    // Day 0 of the next month is the last day of this one.
    const lastDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
    if (day < 1 || day > lastDay) return null;
  }
  return {
    year: year!,
    ...(month !== undefined ? { month } : {}),
    ...(day !== undefined ? { day } : {}),
  };
}

/** One file's metadata as snapshotted when the batch starts. Grouping,
 *  ordering and headings all come from this, so they match the preview
 *  even if the user edits metadata while the batch runs. */
export interface BatchEntry {
  fileId: string;
  name: string;
  newspaperName: string;
  /** As typed — shown in headings. */
  dateText: string;
  date: SortDate | null;
  tags: string[];
}

export function batchEntry(
  state: Pick<AppStore, "getDocumentState">,
  plan: Pick<BatchFilePlan, "fileId" | "name">
): BatchEntry {
  const doc = state.getDocumentState(plan.fileId);
  const dateText = doc.newspaperDate.trim();
  return {
    fileId: plan.fileId,
    name: plan.name,
    newspaperName: doc.newspaperName.trim(),
    dateText,
    date: parseSortDate(dateText),
    tags: [...(doc.tags ?? [])],
  };
}

const collator = new Intl.Collator("zh-Hans-CN", { numeric: true });

function compareDates(a: SortDate | null, b: SortDate | null): number {
  if (!a || !b) return (a ? 0 : 1) - (b ? 0 : 1);
  return (
    a.year - b.year || (a.month ?? 0) - (b.month ?? 0) || (a.day ?? 0) - (b.day ?? 0)
  );
}

/** 报刊名 → 日期 → 文件名 (natural order). Files without a newspaper name
 *  form the last group; within a group, files without a usable date go
 *  last. A year-only date sorts before the full dates of that year. */
export function compareBatchEntries(a: BatchEntry, b: BatchEntry): number {
  if (!a.newspaperName !== !b.newspaperName) return a.newspaperName ? -1 : 1;
  return (
    collator.compare(a.newspaperName, b.newspaperName) ||
    compareDates(a.date, b.date) ||
    collator.compare(a.name, b.name)
  );
}

export function sortBatchEntries(entries: BatchEntry[]): BatchEntry[] {
  return [...entries].sort(compareBatchEntries);
}

/** One output document: its file name stem and the files it contains, in
 *  export order. */
export interface OutputDoc {
  stem: string;
  entries: BatchEntry[];
}

/** Splits sorted entries into output documents. `by_tag` repeats a file in
 *  every tag it carries; files without tags form a final "未分类" doc. */
export function planOutputDocs(
  layout: BatchExportLayout,
  sorted: BatchEntry[]
): OutputDoc[] {
  if (layout === "separate") {
    return sorted.map((e) => ({ stem: stemOf(e.name), entries: [e] }));
  }
  if (layout === "merged") {
    return sorted.length > 0
      ? [{ stem: t("batch.mergedDefaultName"), entries: sorted }]
      : [];
  }
  const tags = [...new Set(sorted.flatMap((e) => e.tags))].sort(collator.compare);
  const docs = tags.map((tag) => ({
    stem: tag,
    entries: sorted.filter((e) => e.tags.includes(tag)),
  }));
  const untagged = sorted.filter((e) => e.tags.length === 0);
  if (untagged.length > 0) docs.push({ stem: t("batch.untagged"), entries: untagged });
  return docs;
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export interface FileExportContent {
  name: string;
  /** Same text the single-file "export all" writes for this mode. */
  markdown: string;
  /** Header lines (报刊名 / 日期) the standalone document opens with. */
  header: string[];
  /** Articles (grouped) or pages (whole-file). `title` is for a standalone
   *  document, `nestedTitle` for a merged one where the unit sits under the
   *  file's own heading. `body` is OCR text, possibly Markdown. */
  units: Array<{ title: string; nestedTitle: string; body: string }>;
  hasText: boolean;
  /** Units whose text is only a failure marker. */
  failedUnits: number;
}

export function buildFileExport(
  state: Pick<AppStore, "articleOcrTexts" | "recognizedPages" | "getDocumentState">,
  plan: BatchFilePlan,
  meta: Pick<BatchEntry, "newspaperName" | "dateText">
): FileExportContent {
  const header = [meta.newspaperName, meta.dateText].filter((l) => l.length > 0);
  if (plan.mode === "grouped") {
    const doc = state.getDocumentState(plan.fileId);
    const texts = state.articleOcrTexts[plan.fileId] ?? {};
    const articles = doc.articles
      .map((a) => ({ title: a.title, text: texts[a.id] ?? "" }))
      .filter((a) => a.text.length > 0);
    return {
      name: plan.name,
      markdown: assembleDocument({
        newspaperName: meta.newspaperName,
        newspaperDate: meta.dateText,
        articles,
      }),
      header,
      units: articles.map((art) => {
        // Same untitled fallback as `assembleDocument`.
        let title = art.title;
        let body = art.text;
        if (!title) {
          const lines = body.trim().split("\n");
          // The first line becomes a heading itself; a Markdown `#` on it
          // would end up as literal text ("### # 社论").
          title = lines[0]?.replace(/^#{1,6}\s*/, "") || t("doc.untitledArticle");
          body = lines.slice(1).join("\n");
        }
        return { title, nestedTitle: title, body: body.trim() };
      }),
      hasText: articles.length > 0,
      failedUnits: articles.filter((a) => isOcrFailureText(a.text)).length,
    };
  }

  const recognized = state.recognizedPages[plan.fileId] ?? {};
  const pages = plan.pages
    .map((page) => ({ page, text: recognized[page]?.text ?? "" }))
    .filter((p) => p.text.length > 0);
  const heading = (page: number) => t("ocr.pageHeading", { page });
  return {
    name: plan.name,
    markdown: pages
      .map((p) => `# ${heading(p.page)}\n\n${p.text.trim()}`)
      .join("\n\n"),
    // The single-file page export has no 报刊名 / 日期 lines; neither does
    // this one, in either format.
    header: [],
    units: pages.map((p) => ({
      title: heading(p.page),
      nestedTitle: t("batch.pageHeading", { name: plan.name, page: p.page }),
      body: p.text.trim(),
    })),
    hasText: pages.length > 0,
    failedUnits: pages.filter((p) => recognized[p.page]?.status === "failed").length,
  };
}

/** Pushes every ATX heading `by` levels down (capped at `######`) so OCR
 *  headings nest under the headings the export adds. */
function shiftHeadings(markdown: string, by: number): string {
  return markdown.replace(/^(#{1,6})(?=\s)/gm, (m) =>
    "#".repeat(Math.min(6, m.length + by))
  );
}

/** Word structure of one file exported on its own. */
export function standaloneDocBlocks(content: FileExportContent): DocBlock[] {
  return [
    ...content.header.map((text) => ({ kind: "paragraph", text }) as DocBlock),
    ...content.units.flatMap((u) => [
      { kind: "heading", level: 1, text: u.title } as DocBlock,
      ...markdownToDocBlocks(u.body, 1),
    ]),
  ];
}

function entryHeading(entry: BatchEntry): string {
  return entry.dateText ? `${entry.dateText} · ${entry.name}` : entry.name;
}

function tagLine(entry: BatchEntry): string | null {
  if (entry.tags.length === 0) return null;
  const joiner = getLanguage() === "zh" ? "、" : ", ";
  return t("batch.tagLine", { tags: entry.tags.join(joiner) });
}

/** Consecutive runs of the same newspaper — `doc.entries` is sorted, so
 *  each newspaper appears as exactly one run. */
function newspaperGroups(entries: BatchEntry[]): Array<[string, BatchEntry[]]> {
  const groups: Array<[string, BatchEntry[]]> = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last[0] === entry.newspaperName) last[1].push(entry);
    else groups.push([entry.newspaperName, [entry]]);
  }
  return groups;
}

/** A merged document: 报刊名 (H1) → 日期 · 文件名 (H2) + tag line →
 *  article title / "文件名 · 第 N 页" (H3) → body. Entries without content
 *  (failed, or nothing recognized) are left out. */
export function mergedMarkdown(
  doc: OutputDoc,
  contents: Map<string, FileExportContent>
): string {
  const out: string[] = [];
  for (const [newspaper, entries] of newspaperGroups(doc.entries)) {
    const present = entries.filter((e) => contents.has(e.fileId));
    if (present.length === 0) continue;
    out.push(`# ${newspaper || t("batch.unnamedGroup")}`);
    for (const entry of present) {
      out.push(`## ${entryHeading(entry)}`);
      const tags = tagLine(entry);
      if (tags) out.push(tags);
      for (const unit of contents.get(entry.fileId)!.units) {
        out.push(`### ${unit.nestedTitle}`);
        if (unit.body) out.push(shiftHeadings(unit.body, 3));
      }
    }
  }
  return out.join("\n\n");
}

export function mergedDocBlocks(
  doc: OutputDoc,
  contents: Map<string, FileExportContent>
): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const [newspaper, entries] of newspaperGroups(doc.entries)) {
    const present = entries.filter((e) => contents.has(e.fileId));
    if (present.length === 0) continue;
    blocks.push({ kind: "heading", level: 1, text: newspaper || t("batch.unnamedGroup") });
    for (const entry of present) {
      blocks.push({ kind: "heading", level: 2, text: entryHeading(entry) });
      const tags = tagLine(entry);
      if (tags) blocks.push({ kind: "paragraph", text: tags });
      for (const unit of contents.get(entry.fileId)!.units) {
        blocks.push({ kind: "heading", level: 3, text: unit.nestedTitle });
        blocks.push(...markdownToDocBlocks(unit.body, 3));
      }
    }
  }
  return blocks;
}

function encodeOutput(
  format: BatchExportFormat,
  markdown: () => string,
  blocks: () => DocBlock[]
): Uint8Array | string {
  return format === "docx" ? buildDocx(blocks()) : markdown();
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function stemOf(name: string): string {
  return name.replace(/\.[^.]+$/, "") || t("common.untitledFile");
}

/** Device names Windows refuses as a file name, with any extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(\..*)?$/i;
/** Room left for " (n).docx" under the common 255-byte name limit. */
const MAX_STEM_BYTES = 200;

/** A tag (or file stem) made safe as a file name on every desktop OS:
 *  path separators, reserved punctuation and C0 / DEL / C1 controls become
 *  "_", trailing dots and spaces go, the result is cut to 200 UTF-8 bytes on
 *  a code-point boundary, and Windows device names get a "_" prefix. */
export function safeFileStem(stem: string): string {
  let cleaned = stem
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f-\u009f]/g, "_")
    .trim();
  const encoder = new TextEncoder();
  if (encoder.encode(cleaned).length > MAX_STEM_BYTES) {
    let out = "";
    for (const ch of cleaned) {
      if (encoder.encode(out + ch).length > MAX_STEM_BYTES) break;
      out += ch;
    }
    cleaned = out;
  }
  cleaned = cleaned.replace(/[. ]+$/, "").trim();
  if (WINDOWS_RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned || "_";
}

async function writeOutput(path: string, data: Uint8Array | string): Promise<void> {
  const fs = await import("@tauri-apps/plugin-fs");
  if (typeof data === "string") await fs.writeTextFile(path, data);
  else await fs.writeFile(path, data);
}

function download(name: string, format: BatchExportFormat, data: Uint8Array | string) {
  const type = format === "docx" ? DOCX_MIME : "text/markdown;charset=utf-8";
  // Copy into a fresh ArrayBuffer-backed view: `Blob` rejects views over a
  // `SharedArrayBuffer` in the DOM typings.
  const part = typeof data === "string" ? data : new Uint8Array(data);
  downloadBlob(new Blob([part], { type }), name);
}

/** File name in `dir` that neither an earlier file of this batch nor an
 *  existing file already uses — the directory picker, unlike the save
 *  panel, never asks before overwriting. */
async function uniqueTargetPath(
  dir: string,
  stem: string,
  ext: string,
  used: Set<string>
): Promise<string> {
  const [{ join }, { exists }] = await Promise.all([
    import("@tauri-apps/api/path"),
    import("@tauri-apps/plugin-fs"),
  ]);
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}.${ext}` : `${stem} (${n}).${ext}`;
    if (used.has(name)) continue;
    const path = await join(dir, name);
    if (await exists(path)) continue;
    used.add(name);
    return path;
  }
}

// ---------------------------------------------------------------------------
// Job events
// ---------------------------------------------------------------------------

type Terminal =
  | { kind: "done"; payload: JobDone }
  | { kind: "error"; error: string };

let waiter: { jobId: string; resolve: (t: Terminal) => void } | null = null;
/** Terminal events that arrived while a start RPC was still in flight —
 *  i.e. before the runner knew the job id. Normally empty. */
const early = new Map<string, Terminal>();
let starting = false;
/** Pages / articles the current job was sent; progress is clamped to it
 *  (a Paddle document job counts the whole submitted PDF). */
let currentRequested = 0;

/** Called by `AppShell` for every job event before its own handlers.
 *  Returns true when the event belonged to the batch and was consumed. */
export function routeBatchJobEvent(
  kind: "progress" | "done" | "error",
  payload: JobProgress | JobDone | JobError
): boolean {
  const jobId = payload.job_id;
  if (kind === "progress") {
    const batch = useStore.getState().batchExport;
    if (!batch || batch.currentJobId !== jobId || batch.currentIndex === null) {
      return false;
    }
    const p = payload as JobProgress;
    const index = batch.currentIndex;
    useStore.getState().updateBatchExport((d) => {
      const item = d.items[index];
      if (!item) return;
      item.total = currentRequested || p.total;
      item.done = Math.min(Math.max(0, p.done), item.total);
    });
    return true;
  }
  const terminal: Terminal =
    kind === "done"
      ? { kind: "done", payload: payload as JobDone }
      : { kind: "error", error: (payload as JobError).error };
  if (waiter && waiter.jobId === jobId) {
    const resolve = waiter.resolve;
    waiter = null;
    resolve(terminal);
    return true;
  }
  // Not provably ours yet: record it, but let the foreground handlers see it
  // too — it may just as well be their job whose start RPC is in flight.
  if (starting) early.set(jobId, terminal);
  return false;
}

function awaitJob(jobId: string): Promise<Terminal> {
  const seen = early.get(jobId);
  early.clear();
  if (seen) return Promise.resolve(seen);
  return new Promise((resolve) => {
    waiter = { jobId, resolve };
  });
}

/** Resolves once `pred` holds for the store. */
function waitUntil(pred: (s: AppStore) => boolean): Promise<void> {
  if (pred(useStore.getState())) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useStore.subscribe((s) => {
      if (!pred(s)) return;
      unsubscribe();
      resolve();
    });
  });
}

const isCancelling = (s: AppStore) => s.batchExport?.status === "cancelling";

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface BatchExportOptions {
  fileIds: string[];
  layout: BatchExportLayout;
  format: BatchExportFormat;
}

export type BatchStartResult =
  | { status: "started" }
  /** The user dismissed the output picker. */
  | { status: "aborted" }
  | { status: "error"; error: string };

export async function startBatchExport(
  opts: BatchExportOptions
): Promise<BatchStartResult> {
  const state = useStore.getState();
  const running = state.batchExport;
  if (running && (running.status === "running" || running.status === "cancelling")) {
    return { status: "error", error: t("batch.alreadyRunning") };
  }
  // Processing order is export order: 报刊名 → 日期 → 文件名.
  const unsorted = opts.fileIds.map((id) => planBatchFile(state, id));
  const entries = sortBatchEntries(unsorted.map((p) => batchEntry(state, p)));
  const planById = new Map(unsorted.map((p) => [p.fileId, p]));
  const plans = entries.map((e) => planById.get(e.fileId)!);
  if (plans.length === 0 || plans.every((p) => p.error)) {
    return { status: "error", error: t("batch.noFiles") };
  }
  const needsOcr = plans.some((p) => {
    if (p.error) return false;
    const missing = missingUnits(state, p);
    return missing.articles.length + missing.pages.length > 0;
  });
  if (needsOcr) {
    const setupError = await providerSetupError(state.settings);
    if (setupError) return { status: "error", error: setupError };
  }

  // Ask for the destination now: once started, the batch runs unattended and
  // must not pop a dialog over whatever the user is doing.
  let target = "";
  if (isTauriRuntime()) {
    const { open, save } = await import("@tauri-apps/plugin-dialog");
    if (opts.layout !== "merged") {
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir !== "string") return { status: "aborted" };
      target = dir;
    } else {
      const path = await save({
        defaultPath: `${t("batch.mergedDefaultName")}.${opts.format}`,
        filters: [
          {
            name: opts.format === "docx" ? "Word" : "Markdown",
            extensions: [opts.format],
          },
        ],
      });
      if (!path) return { status: "aborted" };
      target = path;
    }
  }
  await enableNotificationsAfterUserAction();

  const items: BatchExportItem[] = plans.map((p) => ({
    fileId: p.fileId,
    name: p.name,
    mode: p.mode,
    unitCount: p.mode === "grouped" ? p.articles.length : p.pages.length,
    status: p.error ? "failed" : "pending",
    done: 0,
    total: 0,
    failedUnits: 0,
    ...(p.error ? { error: p.error } : {}),
  }));
  const initial: BatchExportState = {
    status: "running",
    layout: opts.layout,
    format: opts.format,
    items,
    currentIndex: null,
    currentJobId: null,
    target,
  };
  useStore.getState().setBatchExport(initial);
  void runBatch(plans, entries).catch((e) => {
    const message = appErrorMessage(e);
    void logWarn(`batch export failed: ${message}`);
    useStore.getState().updateBatchExport((d) => {
      d.status = "done";
      d.currentIndex = null;
      d.currentJobId = null;
      d.error = message;
    });
  });
  return { status: "started" };
}

export function cancelBatchExport(): void {
  const batch = useStore.getState().batchExport;
  if (!batch || batch.status !== "running") return;
  useStore.getState().updateBatchExport((d) => {
    d.status = "cancelling";
  });
  if (batch.currentJobId) void cancelCurrentJob(batch.currentJobId);
}

async function cancelCurrentJob(jobId: string): Promise<void> {
  let accepted = false;
  try {
    accepted = await cancelJob(jobId);
  } catch (e) {
    void logWarn(`batch cancel failed: ${appErrorMessage(e)}`);
  }
  // The job already left the registry: no cancelled `done` will follow, so
  // release the runner ourselves.
  if (!accepted && waiter?.jobId === jobId) {
    const resolve = waiter.resolve;
    waiter = null;
    resolve({ kind: "error", error: t("batch.cancelledTitle") });
  }
}

function patchItem(index: number, patch: Partial<BatchExportItem>): void {
  useStore.getState().updateBatchExport((d) => {
    const item = d.items[index];
    if (item) Object.assign(item, patch);
  });
}

const fileExists = (s: AppStore, fileId: string) =>
  s.files.some((f) => f.id === fileId);

async function runBatch(plans: BatchFilePlan[], entries: BatchEntry[]): Promise<void> {
  const batch = useStore.getState().batchExport!;
  const { layout, format, target } = batch;
  const usedNames = new Set<string>();
  // fileId → content, filled as files finish. Merged layouts render from it
  // at the end, so a file under several tags is recognized once and only
  // written several times.
  const contents = new Map<string, FileExportContent>();

  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index]!;
    if (plan.error) continue;
    if (isCancelling(useStore.getState())) break;
    if (!fileExists(useStore.getState(), plan.fileId)) {
      patchItem(index, { status: "skipped", error: t("batch.removed") });
      continue;
    }

    // Never run alongside a foreground job on the same file: wait it out.
    await waitUntil((s) => {
      if (isCancelling(s) || !fileExists(s, plan.fileId)) return true;
      const job = s.activeJob;
      const fgRunning =
        !!job &&
        job.fileId === plan.fileId &&
        (job.status === "running" || job.status === "cancelling");
      const fgStarting =
        s.jobStartClaim !== null && s.jobStartClaimFileId === plan.fileId;
      return !fgRunning && !fgStarting;
    });
    if (isCancelling(useStore.getState())) break;
    if (!fileExists(useStore.getState(), plan.fileId)) {
      patchItem(index, { status: "skipped", error: t("batch.removed") });
      continue;
    }

    useStore.getState().updateBatchExport((d) => {
      d.currentIndex = index;
    });
    patchItem(index, { status: "running" });

    const outcome = await recognizeFile(index, plan);
    useStore.getState().updateBatchExport((d) => {
      d.currentIndex = null;
      d.currentJobId = null;
    });
    if (outcome === "cancelled") {
      patchItem(index, { status: "skipped" });
      break;
    }
    if (outcome === "removed") {
      patchItem(index, { status: "skipped", error: t("batch.removed") });
      continue;
    }
    if (outcome !== "ok") {
      patchItem(index, { status: "failed", error: outcome.error });
      continue;
    }

    const content = buildFileExport(useStore.getState(), plan, entries[index]!);
    if (!content.hasText) {
      patchItem(index, { status: "failed", error: t("batch.noText") });
      continue;
    }
    // A document of nothing but failure markers is not an export.
    if (content.failedUnits === content.units.length) {
      patchItem(index, {
        status: "failed",
        failedUnits: content.failedUnits,
        error: t("batch.allFailed"),
      });
      continue;
    }
    patchItem(index, { failedUnits: content.failedUnits });
    if (layout !== "separate") {
      contents.set(plan.fileId, content);
      patchItem(index, { status: "done" });
      continue;
    }
    try {
      const data = encodeOutput(
        format,
        () => content.markdown,
        () => standaloneDocBlocks(content)
      );
      const stem = safeFileStem(stemOf(plan.name));
      if (isTauriRuntime()) {
        await writeOutput(await uniqueTargetPath(target, stem, format, usedNames), data);
      } else {
        download(`${stem}.${format}`, format, data);
      }
      patchItem(index, { status: "done" });
    } catch (e) {
      patchItem(index, {
        status: "failed",
        error: t("batch.writeFailed", { message: appErrorMessage(e) }),
      });
    }
  }

  let batchError: string | undefined;
  if (layout !== "separate" && !isCancelling(useStore.getState())) {
    const docs = planOutputDocs(layout, entries).filter((doc) =>
      doc.entries.some((e) => contents.has(e.fileId))
    );
    if (docs.length === 0) batchError = t("batch.noText");
    for (const doc of docs) {
      // Writing several tag documents can take a while; honour a cancel
      // between them.
      if (isCancelling(useStore.getState())) break;
      try {
        const data = encodeOutput(
          format,
          () => mergedMarkdown(doc, contents),
          () => mergedDocBlocks(doc, contents)
        );
        const stem = safeFileStem(doc.stem);
        if (!isTauriRuntime()) download(`${stem}.${format}`, format, data);
        else if (layout === "merged") await writeOutput(target, data);
        else await writeOutput(await uniqueTargetPath(target, stem, format, usedNames), data);
      } catch (e) {
        batchError ??= t("batch.writeFailed", { message: appErrorMessage(e) });
      }
    }
  }

  // Read after the writes: a cancel can land while they run.
  const cancelled = isCancelling(useStore.getState());
  useStore.getState().updateBatchExport((d) => {
    d.status = cancelled ? "cancelled" : "done";
    d.currentIndex = null;
    d.currentJobId = null;
    for (const item of d.items) {
      if (item.status === "pending" || item.status === "running") {
        item.status = "skipped";
      }
    }
    if (batchError) d.error = batchError;
  });

  const final = useStore.getState().batchExport;
  if (!final || cancelled) return;
  void notifyOcrResult({
    fileId: final.items[0]?.fileId ?? "",
    title: t("batch.finished"),
    body: final.error ?? batchSummaryText(final.items),
  });
}

/** done: exported with every unit recognized; partial: exported, but some
 *  units carry a failure marker; failed: not exported (skipped included). */
export function summarizeBatch(items: BatchExportItem[]): {
  ok: number;
  partial: number;
  failed: number;
} {
  let ok = 0;
  let partial = 0;
  for (const item of items) {
    if (item.status !== "done") continue;
    if (item.failedUnits > 0) partial++;
    else ok++;
  }
  return { ok, partial, failed: items.length - ok - partial };
}

export function batchSummaryText(items: BatchExportItem[]): string {
  const counts = summarizeBatch(items);
  return counts.partial > 0
    ? t("batch.summaryPartial", counts)
    : t("batch.summary", counts);
}

type RecognizeOutcome = "ok" | "cancelled" | "removed" | { error: string };

/** Runs OCR for whatever the file is still missing and writes the results
 *  back. Resolves "ok" without starting a job when nothing is missing. */
async function recognizeFile(
  index: number,
  plan: BatchFilePlan
): Promise<RecognizeOutcome> {
  const state = useStore.getState();
  const missing = missingUnits(state, plan);
  const requested =
    plan.mode === "grouped" ? missing.articles.length : missing.pages.length;
  if (requested === 0) return "ok";

  const file = state.files.find((f) => f.id === plan.fileId);
  if (!file) return "removed";
  const doc = state.getDocumentState(plan.fileId);
  const newspaperName = doc.newspaperName;
  const newspaperDate = doc.newspaperDate;

  let jobId: string;
  starting = true;
  early.clear();
  try {
    const started =
      plan.mode === "grouped"
        ? await startGroupedOcr({
            file_id: plan.fileId,
            path: file.path,
            kind: file.kind,
            preview_dpi: file.kind === "pdf" ? ACTIVE_PREVIEW_DPI : 0,
            ocr_dpi: 0,
            articles: missing.articles,
            newspaper_name: newspaperName,
            newspaper_date: newspaperDate,
          })
        : await startWholeFileOcr({
            file_id: plan.fileId,
            path: file.path,
            kind: file.kind,
            pages: missing.pages,
            ocr_dpi: 0,
            newspaper_name: newspaperName,
            newspaper_date: newspaperDate,
          });
    jobId = started.job_id;
  } catch (e) {
    return { error: appErrorMessage(e) };
  } finally {
    starting = false;
  }

  currentRequested = requested;
  useStore.getState().updateBatchExport((d) => {
    d.currentJobId = jobId;
  });
  patchItem(index, { done: 0, total: requested });
  // A cancel or a removal that landed while the start RPC was in flight saw
  // no job id to cancel; act on it now. The subscription below only sees
  // later changes.
  if (isCancelling(useStore.getState()) || !fileExists(useStore.getState(), plan.fileId)) {
    void cancelCurrentJob(jobId);
  }

  // Removing the file from the queue mid-job cancels its job.
  const unsubscribe = useStore.subscribe((s) => {
    if (!fileExists(s, plan.fileId)) {
      unsubscribe();
      void cancelCurrentJob(jobId);
    }
  });
  const terminal = await awaitJob(jobId).finally(unsubscribe);
  currentRequested = 0;

  if (!fileExists(useStore.getState(), plan.fileId)) return "removed";
  if (terminal.kind === "error") {
    return isCancelling(useStore.getState()) ? "cancelled" : { error: terminal.error };
  }
  if (terminal.payload.cancelled) return "cancelled";

  // Failure counts are taken from the exported content afterwards, which
  // also covers units reused from earlier runs.
  if (plan.mode === "grouped") {
    useStore.getState().writeGroupedJobResults(
      plan.fileId,
      missing.articles.map((a) => ({
        id: a.id,
        title: a.title,
        region: articleRegionKey(a),
      })),
      terminal.payload as GroupedJobDone,
      newspaperName,
      newspaperDate
    );
  } else {
    useStore
      .getState()
      .writeWholeFileJobResults(
        plan.fileId,
        jobId,
        missing.pages,
        terminal.payload as WholeFileJobDone
      );
  }
  patchItem(index, { done: requested });
  return "ok";
}
