import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import {
  AlertTriangle,
  ChevronDown,
  FileDown,
  FileJson,
  FileText,
  X,
} from "lucide-react";
import { appErrorMessage } from "@/lib/ipc-types";
import {
  analyzePaddleJson as ipcAnalyzePaddleJson,
  exportLayoutPdf as ipcExportLayoutPdf,
  exportReadingMarkdown as ipcExportReadingMarkdown,
  importPaddleJson as ipcImportPaddleJson,
} from "@/lib/tauri";
import type {
  LayoutPdfExportOptions,
  PaddleJsonImport,
  PaddleJsonPreflightReport,
} from "@/lib/layout-document";
import { DEFAULT_LAYOUT_PDF_EXPORT_OPTIONS } from "@/lib/layout-document";
import { useStore } from "@/store";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { t as translate, useT } from "@/i18n";
import type { RecognizedPage } from "@/store/jobSlice";

interface PaddleJsonImportDialogProps {
  open: boolean;
  /** Path picked by the user. When `null`, the dialog renders nothing — the
   *  parent owns the open/close lifecycle. */
  path: string | null;
  onClose: () => void;
}

interface DialogState {
  status: "loading" | "ready" | "error" | "writing" | "done";
  preflight?: PaddleJsonPreflightReport;
  /** Full import payload — captured during preflight if the file is small
   *  enough to read twice cheaply. Kept around so the confirm path can reuse
   *  it instead of re-parsing the file. */
  imported?: PaddleJsonImport;
  errorMessage?: string;
}

interface ExportFeedback {
  kind: "success" | "error";
  summary: string;
  warningCount: number;
  warnings: string[];
}

/** The two reading-version outputs. They are peer choices rather than a
 *  primary/secondary pair, so the footer carries one button and the format
 *  is picked in the options panel — two same-weight buttons side by side
 *  just made the footer read as cluttered. */
type ExportFormat = "pdf" | "markdown";

const EXPORT_FORMATS: Record<
  ExportFormat,
  {
    label: string;
    extension: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }
> = {
  pdf: {
    label: "PDF",
    extension: "pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  },
  markdown: {
    label: "Markdown",
    extension: "md",
    filters: [{ name: "Markdown", extensions: ["md"] }],
  },
};

/** Which raw block labels each label-gated export option governs. Mirrors
 *  `classify()` in layout_pdf.rs: exact-match roles win over the contains()
 *  fallbacks (so `table_title` is a caption, not a table). `includePageNumber`
 *  is absent on purpose — the page anchor is synthesized, not label-based. */
type LabelGatedOption = "header" | "footer" | "aside" | "footnote" | "table";

const HEADER_LABELS = new Set(["header", "doc_header", "header_image"]);
const FOOTER_LABELS = new Set(["footer", "doc_footer", "footer_image"]);
const ASIDE_LABELS = new Set(["aside_text", "aside"]);
const CAPTION_LABELS = new Set(["figure_title", "chart_title", "table_title"]);

function labelGatedRole(rawLabel: string): LabelGatedOption | null {
  const label = rawLabel.trim().toLowerCase();
  if (HEADER_LABELS.has(label)) return "header";
  if (FOOTER_LABELS.has(label)) return "footer";
  if (ASIDE_LABELS.has(label)) return "aside";
  if (CAPTION_LABELS.has(label)) return null;
  if (label.includes("footnote")) return "footnote";
  if (label.includes("table")) return "table";
  return null;
}

function countLabelGatedBlocks(
  labelCounts: Record<string, number>
): Record<LabelGatedOption, number> {
  const counts: Record<LabelGatedOption, number> = {
    header: 0,
    footer: 0,
    aside: 0,
    footnote: 0,
    table: 0,
  };
  for (const [label, count] of Object.entries(labelCounts)) {
    const role = labelGatedRole(label);
    if (role) counts[role] += count;
  }
  return counts;
}

function defaultExportNameFromPath(path: string, ext: string): string {
  const filename = path.split(/[\\/]/).pop() || "paddle-json";
  return `${filename.replace(/\.[^.]+$/, "")}_${translate(
    "file.suffix.reading"
  )}.${ext}`;
}

export function PaddleJsonImportDialog({
  open,
  path,
  onClose,
}: PaddleJsonImportDialogProps) {
  const t = useT();
  const [state, setState] = useState<DialogState>({ status: "loading" });
  const [exportFormat, setExportFormat] = useState<ExportFormat>("pdf");
  const [exporting, setExporting] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<ExportFeedback | null>(
    null
  );
  const [exportWarningsOpen, setExportWarningsOpen] = useState(false);
  const [exportOptions, setExportOptions] = useState<LayoutPdfExportOptions>(
    DEFAULT_LAYOUT_PDF_EXPORT_OPTIONS
  );

  // Initial focus, focus trap, and focus restore on close.
  const dialogRef = useRef<HTMLDivElement>(null);
  const isOpen = open && path !== null;
  useDialogFocus(isOpen, dialogRef);

  // Escape dismisses, like every other dialog in the app and every native
  // sheet. This one was the outlier.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const currentFile = useStore((s) =>
    s.currentFileId
      ? s.files.find((f) => f.id === s.currentFileId) ?? null
      : null
  );
  const currentPdf = currentFile?.kind === "pdf" ? currentFile : null;
  const currentFileId = currentPdf?.id ?? null;
  const setRecognizedPages = useStore((s) => s.setRecognizedPages);
  const setRecognitionMode = useStore((s) => s.setRecognitionMode);
  const setCurrentPage = useStore((s) => s.setCurrentPage);

  useEffect(() => {
    if (!open || !path) return;
    let cancelled = false;
    setState({ status: "loading" });
    setExportFeedback(null);
    setExportWarningsOpen(false);
    setExportFormat("pdf");
    setExportOptions(DEFAULT_LAYOUT_PDF_EXPORT_OPTIONS);
    // Pull the full import payload up front: the Rust side already does the
    // heavy parse work, and confirming should be instant. If the user
    // cancels, we just throw the parsed payload away.
    (async () => {
      try {
        const imported = await ipcImportPaddleJson(path);
        if (cancelled) return;
        setState({
          status: "ready",
          preflight: imported.preflight,
          imported,
        });
      } catch (e) {
        if (cancelled) return;
        setState({
          status: "error",
          errorMessage: appErrorMessage(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, path]);

  function commit() {
    if (state.status !== "ready" || !state.imported || !currentFileId) return;
    setState((prev) => ({ ...prev, status: "writing" }));
    try {
      const imported = state.imported;
      const layoutByPage = new Map(
        imported.document.pages.map((p) => [p.index, p])
      );
      const pages: Record<number, RecognizedPage> = {};
      for (const entry of imported.pageTexts) {
        const layout = layoutByPage.get(entry.page);
        pages[entry.page] = {
          text: entry.text,
          status: "done",
          sourceMode: "paddle_json_import",
          ...(layout ? { layout } : {}),
        };
      }
      setRecognizedPages(currentFileId, pages);
      // Make the new results immediately visible. The user explicitly chose
      // to import for the current file, so switching the recognition mode
      // here is expected — not a side effect.
      setRecognitionMode("whole_file");
      const firstPage = imported.pageTexts[0]?.page ?? 1;
      setCurrentPage(currentFileId, firstPage);
      onClose();
    } catch (e) {
      void logWarn(`paddle json write failed: ${appErrorMessage(e)}`).catch(
        () => {}
      );
      setState((prev) => ({
        ...prev,
        status: "error",
        errorMessage: appErrorMessage(e),
      }));
    }
  }

  /** One export path for both formats — they differ only in the save-dialog
   *  filter and which IPC command runs; both results share the same shape. */
  async function runExport(): Promise<void> {
    if (state.status !== "ready" || !state.imported || !path) return;
    const spec = EXPORT_FORMATS[exportFormat];
    setExporting(true);
    setExportFeedback(null);
    setExportWarningsOpen(false);
    try {
      const targetPath = await saveDialog({
        defaultPath: defaultExportNameFromPath(path, spec.extension),
        filters: spec.filters,
      });
      if (!targetPath) return;
      const req = {
        document: state.imported.document,
        targetPath,
        options: exportOptions,
      };
      const result =
        exportFormat === "pdf"
          ? await ipcExportLayoutPdf(req)
          : await ipcExportReadingMarkdown(req);
      setExportFeedback({
        kind: "success",
        summary: t("paddleJson.exportedSummary", {
          format: spec.label,
          count: result.pageCount,
        }),
        warningCount: result.warningCount,
        warnings: result.warnings,
      });
    } catch (e) {
      setExportFeedback({
        kind: "error",
        summary: t("ocr.exportFailed", { message: appErrorMessage(e) }),
        warningCount: 0,
        warnings: [],
      });
    } finally {
      setExporting(false);
    }
  }

  if (!open || !path) return null;

  return (
    // See SettingsDialog: dialogs mount outside the shell's <main>, so they
    // have to opt into the app-chrome rules themselves.
    <div className="app-chrome fixed inset-0 z-50 flex items-center justify-center">
      <div
        role="presentation"
        // Black rather than foreground-derived — see SettingsDialog scrim.
        className="absolute inset-0 bg-black/35 dark:bg-black/55"
        onClick={onClose}
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="paddle-json-import-title"
        className="relative flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-[10px] border border-border bg-surface shadow-[0_20px_60px_-24px_rgba(0,0,0,0.22)]"
      >
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileJson className="h-4 w-4 text-foreground-muted" strokeWidth={1.75} />
            <h2
              id="paddle-json-import-title"
              className="truncate text-[15px] font-medium text-foreground"
            >
              {t("paddleJson.title")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
aria-label={t("common.close")}
            className="grid h-7 w-7 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 text-[12px] leading-relaxed">
          <p
            className="truncate font-mono text-[11px] text-foreground-subtle"
            title={path}
          >
            {path}
          </p>
          <p className="mt-1.5 text-[12px] text-foreground-muted">
            {t("paddleJson.desc")}
          </p>

          {state.status === "loading" && (
            <p className="mt-4 text-foreground-muted">
              {t("paddleJson.analyzing")}
            </p>
          )}
          {state.status === "error" && (
            <p className="mt-4 text-destructive" role="alert">
              {t("paddleJson.readFailed", {
                message: state.errorMessage ?? t("common.unknownError"),
              })}
            </p>
          )}

          {(state.status === "ready" || state.status === "writing") &&
            state.preflight && (
              <div className="mt-4 flex flex-col gap-4">
                <PreflightSummary
                  preflight={state.preflight}
                  pdfTotal={currentPdf?.pdfTotal}
                />
                <ExportOptionsPanel
                  options={exportOptions}
                  labelCounts={state.preflight.labelCounts}
                  onChange={setExportOptions}
                  format={exportFormat}
                  onFormatChange={setExportFormat}
                />
              </div>
            )}
        </div>

        {(state.status === "ready" || state.status === "writing") && (
          <footer className="flex flex-col gap-2 border-t border-border bg-surface-2 px-5 py-3">
            {exportFeedback?.kind === "success" &&
              exportFeedback.warningCount > 0 && (
                <div
                  id="paddle-export-warnings"
                  hidden={!exportWarningsOpen}
                  className="rounded border border-warning/30 bg-surface px-3 py-2"
                >
                  <div className="mb-1 text-[11px] font-medium text-foreground-muted">
                    {t("paddleJson.warningsTitle")}
                  </div>
                  <ul className="flex max-h-28 flex-col gap-1 overflow-y-auto">
                    {exportFeedback.warnings.map((warning, idx) => (
                      <li
                        key={`${idx}-${warning}`}
                        className="flex items-start gap-1.5 text-[11px] leading-relaxed text-foreground-muted"
                      >
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
                        <span>{warning}</span>
                      </li>
                    ))}
                    {exportFeedback.warningCount >
                      exportFeedback.warnings.length && (
                      <li className="text-[11px] text-foreground-subtle">
                        {t("paddleJson.moreWarnings", {
                          count:
                            exportFeedback.warningCount -
                            exportFeedback.warnings.length,
                        })}
                      </li>
                    )}
                  </ul>
                </div>
              )}

            <div className="flex items-center justify-between gap-2">
              <div
                className={`flex min-w-0 flex-1 items-center gap-1.5 text-[11px] ${
                  exportFeedback?.kind === "error"
                    ? "text-destructive"
                    : "text-foreground-subtle"
                }`}
              >
                <span
                  className="truncate"
                  title={exportFeedback?.summary}
                >
                  {exportFeedback?.summary ?? ""}
                </span>
                {exportFeedback?.kind === "success" &&
                  exportFeedback.warningCount > 0 && (
                    <button
                      type="button"
                      aria-expanded={exportWarningsOpen}
                      aria-controls="paddle-export-warnings"
                      onClick={() => setExportWarningsOpen((open) => !open)}
                      className="inline-flex shrink-0 items-center gap-0.5 font-medium text-foreground-muted hover:text-foreground"
                    >
                      {exportWarningsOpen
                        ? t("paddleJson.hideWarnings", {
                            count: exportFeedback.warningCount,
                          })
                        : t("paddleJson.showWarnings", {
                            count: exportFeedback.warningCount,
                          })}
                      <ChevronDown
                        className={`h-3 w-3 transition-transform ${
                          exportWarningsOpen ? "rotate-180" : ""
                        }`}
                        strokeWidth={1.75}
                      />
                    </button>
                  )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-7 rounded px-3 text-[12px] text-foreground-muted hover:bg-surface hover:text-foreground"
                >
                  {t("common.cancel")}
                </button>
                {currentPdf && (
                  <button
                    type="button"
                    onClick={commit}
                    disabled={state.status !== "ready" || !currentFileId}
                    className="h-7 rounded border border-border/60 px-3 text-[12px] text-foreground-muted hover:bg-surface hover:text-foreground active:bg-surface-overlay disabled:cursor-default disabled:opacity-50"
                    title={t("paddleJson.writeTo", { name: currentPdf.name })}
                  >
                    {t("paddleJson.writePageTexts")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void runExport()}
                  disabled={
                    exporting ||
                    state.status !== "ready" ||
                    !state.imported?.document.pages.length
                  }
                  className="inline-flex h-7 items-center gap-1.5 rounded bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-opacity hover:bg-primary/90 active:bg-primary/80 disabled:cursor-default disabled:opacity-50"
                >
                  {exportFormat === "pdf" ? (
                    <FileDown className="h-3.5 w-3.5" strokeWidth={1.75} />
                  ) : (
                    <FileText className="h-3.5 w-3.5" strokeWidth={1.75} />
                  )}
                  {exporting
                    ? t("paddleJson.exporting")
                    : t("paddleJson.exportButton", {
                        format: EXPORT_FORMATS[exportFormat].label,
                      })}
                </button>
              </div>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

/** Just the numbers a user needs to sanity-check the file they picked, plus
 *  the one mismatch that changes what "write per-page text" will do. Everything else the
 *  preflight reports (structure fields, label histogram, model settings,
 *  parser warnings) is diagnostic detail and stays out of the dialog. */
function PreflightSummary({
  preflight,
  pdfTotal,
}: {
  preflight: PaddleJsonPreflightReport;
  pdfTotal: number | undefined;
}) {
  const t = useT();
  const pageMismatch = pdfTotal != null && pdfTotal !== preflight.pageCount;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 divide-x divide-border/60 overflow-hidden rounded-lg border border-border/60 bg-surface-2/40">
        <Stat
          label={t("paddleJson.statPages")}
          value={preflight.pageCount.toLocaleString()}
        />
        <Stat
          label={t("paddleJson.statBlocks")}
          value={preflight.blockCount.toLocaleString()}
        />
        <Stat
          label={t("paddleJson.statLabels")}
          value={Object.keys(preflight.labelCounts).length.toString()}
        />
      </div>

      {pageMismatch && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t("paddleJson.pageMismatch", {
              jsonPages: preflight.pageCount,
              pdfPages: pdfTotal ?? 0,
            })}
          </span>
        </div>
      )}
    </div>
  );
}

function ExportOptionsPanel({
  options,
  labelCounts,
  onChange,
  format,
  onFormatChange,
}: {
  options: LayoutPdfExportOptions;
  labelCounts: Record<string, number>;
  onChange: (next: LayoutPdfExportOptions) => void;
  format: ExportFormat;
  onFormatChange: (next: ExportFormat) => void;
}) {
  const t = useT();
  const setOption = <K extends keyof LayoutPdfExportOptions>(
    key: K,
    value: LayoutPdfExportOptions[K]
  ) => onChange({ ...options, [key]: value });
  const blockCounts = useMemo(
    () => countLabelGatedBlocks(labelCounts),
    [labelCounts]
  );

  return (
    <div className="rounded-lg border border-border/60 bg-surface-2/40 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="text-[12px] font-medium text-foreground">
          {t("paddleJson.optionsTitle")}
        </div>
        <FormatToggle value={format} onChange={onFormatChange} />
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-x-5">
        <OptionCheck
          label={t("paddleJson.opt.pageAnchor")}
          checked={options.includePageNumber}
          onChange={(v) => setOption("includePageNumber", v)}
        />
        <OptionCheck
          label={t("paddleJson.opt.footnote")}
          count={blockCounts.footnote}
          checked={options.includeFootnote}
          onChange={(v) => setOption("includeFootnote", v)}
        />
        <OptionCheck
          label={t("paddleJson.opt.table")}
          count={blockCounts.table}
          checked={options.includeTables}
          onChange={(v) => setOption("includeTables", v)}
        />
        <OptionCheck
          label={t("paddleJson.opt.aside")}
          count={blockCounts.aside}
          checked={options.includeAsideText}
          onChange={(v) => setOption("includeAsideText", v)}
        />
        <OptionCheck
          label={t("paddleJson.opt.header")}
          count={blockCounts.header}
          checked={options.includeHeader}
          onChange={(v) => setOption("includeHeader", v)}
        />
        <OptionCheck
          label={t("paddleJson.opt.footer")}
          count={blockCounts.footer}
          checked={options.includeFooter}
          onChange={(v) => setOption("includeFooter", v)}
        />
      </div>
      <p className="mt-2.5 text-[11px] text-foreground-subtle">
        {t("paddleJson.imagesNote")}
      </p>
    </div>
  );
}

/** Segmented control for the output format. Sits with the export options
 *  rather than in the footer so the footer keeps a single action button. */
function FormatToggle({
  value,
  onChange,
}: {
  value: ExportFormat;
  onChange: (next: ExportFormat) => void;
}) {
  const t = useT();
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 bg-surface p-0.5"
      role="group"
      aria-label={t("paddleJson.formatGroup")}
    >
      {(Object.keys(EXPORT_FORMATS) as ExportFormat[]).map((key) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(key)}
            className={`h-5 rounded px-2 text-[11px] transition-colors ${
              active
                ? "bg-primary font-medium text-primary-foreground active:bg-primary/80"
                : "text-foreground-muted hover:text-foreground active:bg-surface-overlay"
            }`}
          >
            {EXPORT_FORMATS[key].label}
          </button>
        );
      })}
    </div>
  );
}

function OptionCheck({
  label,
  checked,
  onChange,
  count,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Block count for label-gated options; omit for options that always
   *  apply (e.g. the synthesized page anchor). Zero disables the checkbox. */
  count?: number;
}) {
  const t = useT();
  const disabled = count === 0;
  return (
    <label
      className={`flex h-7 items-center gap-2 rounded px-1.5 text-[12px] ${
        disabled
          ? "text-foreground-subtle"
          : "text-foreground hover:bg-surface active:bg-surface-overlay"
      }`}
      title={disabled ? t("paddleJson.optionDisabled") : undefined}
    >
      <input
        type="checkbox"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="h-3.5 w-3.5 shrink-0 accent-primary disabled:cursor-default"
      />
      <span className="flex-1 truncate">{label}</span>
      {count != null && (
        <span className="shrink-0 text-[11px] tabular-nums text-foreground-subtle">
          {count > 0 ? count.toLocaleString() : t("common.none")}
        </span>
      )}
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2">
      <div className="text-[10px] tracking-wide text-foreground-subtle">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-[15px] font-medium tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

/**
 * Helper hook the queue panel uses to open a file dialog and stash the
 * resulting path so the dialog can render. Lives here so consumers only
 * import one symbol pair.
 */
export function usePaddleJsonImportFlow() {
  const [path, setPath] = useState<string | null>(null);

  const open = useCallback(async (): Promise<void> => {
    try {
      const selection = await openDialog({
        multiple: false,
        filters: [{ name: "Paddle JSON", extensions: ["json"] }],
      });
      if (typeof selection === "string" && selection.length > 0) {
        setPath(selection);
      }
    } catch (e) {
      void logWarn(`open paddle json dialog failed: ${appErrorMessage(e)}`).catch(
        () => {}
      );
    }
  }, []);

  const close = useCallback(() => setPath(null), []);

  // `ipcAnalyzePaddleJson` isn't actually called from the flow — the
  // dialog uses `importPaddleJson` directly because it always needs the
  // full payload anyway. We re-export the symbol so the queue panel can
  // ergonomically lazy-call analyze in the future (e.g. for a quick
  // "compatibility check" without staging an import).
  return { path, open, close, analyze: ipcAnalyzePaddleJson };
}
