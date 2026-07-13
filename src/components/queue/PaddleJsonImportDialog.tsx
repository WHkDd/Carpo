import { useEffect, useMemo, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import { AlertTriangle, FileDown, FileJson, FileText, X } from "lucide-react";
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

/** Static blurb for each preflight bullet. The dialog labels these as
 *  "已确认开启 / 已确认关闭 / 结构存在 / 结构缺失" per plan §9.5. */
const STRUCTURE_DESCRIPTIONS: Array<{
  key: keyof PaddleJsonPreflightReport;
  label: string;
}> = [
  { key: "hasParsingResults", label: "区块解析结果 (parsing_res_list)" },
  { key: "hasBlockBbox", label: "区块位置 (block_bbox)" },
  { key: "hasBlockOrder", label: "阅读顺序 (block_order)" },
  { key: "hasPolygonPoints", label: "区块多边形 (block_polygon_points)" },
  { key: "hasMarkdown", label: "页面 Markdown 文本 (markdown.text)" },
  { key: "hasImages", label: "Markdown 内嵌图片 (markdown.images)" },
  { key: "hasOutputImages", label: "版面渲染图 (outputImages)" },
];

const PDF_FILTERS = [{ name: "PDF", extensions: ["pdf"] }];
const MD_FILTERS = [{ name: "Markdown", extensions: ["md"] }];

function defaultExportNameFromPath(path: string, ext: string): string {
  const filename = path.split(/[\\/]/).pop() || "paddle-json";
  return `${filename.replace(/\.[^.]+$/, "")}_阅读版.${ext}`;
}

export function PaddleJsonImportDialog({
  open,
  path,
  onClose,
}: PaddleJsonImportDialogProps) {
  const [state, setState] = useState<DialogState>({ status: "loading" });
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingMarkdown, setExportingMarkdown] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportOptions, setExportOptions] = useState<LayoutPdfExportOptions>(
    DEFAULT_LAYOUT_PDF_EXPORT_OPTIONS
  );

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
    setExportMessage(null);
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

  async function exportReadingPdf(): Promise<void> {
    if (state.status !== "ready" || !state.imported || !path) return;
    setExportingPdf(true);
    setExportMessage(null);
    try {
      const targetPath = await saveDialog({
        defaultPath: defaultExportNameFromPath(path, "pdf"),
        filters: PDF_FILTERS,
      });
      if (!targetPath) return;
      const result = await ipcExportLayoutPdf({
        document: state.imported.document,
        targetPath,
        options: exportOptions,
      });
      setExportMessage(
        result.warningCount > 0
          ? `已导出 PDF ${result.pageCount} 页 · ${result.warningCount} 个提示`
          : `已导出 PDF ${result.pageCount} 页`
      );
    } catch (e) {
      setExportMessage(`导出失败：${appErrorMessage(e)}`);
    } finally {
      setExportingPdf(false);
    }
  }

  async function exportReadingMarkdown(): Promise<void> {
    if (state.status !== "ready" || !state.imported || !path) return;
    setExportingMarkdown(true);
    setExportMessage(null);
    try {
      const targetPath = await saveDialog({
        defaultPath: defaultExportNameFromPath(path, "md"),
        filters: MD_FILTERS,
      });
      if (!targetPath) return;
      const result = await ipcExportReadingMarkdown({
        document: state.imported.document,
        targetPath,
        options: exportOptions,
      });
      setExportMessage(
        result.warningCount > 0
          ? `已导出 Markdown ${result.pageCount} 页 · ${result.warningCount} 个提示`
          : `已导出 Markdown ${result.pageCount} 页`
      );
    } catch (e) {
      setExportMessage(`导出失败：${appErrorMessage(e)}`);
    } finally {
      setExportingMarkdown(false);
    }
  }

  if (!open || !path) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="paddle-json-import-title"
    >
      <button
        type="button"
        aria-label="关闭导入对话框"
        className="absolute inset-0 bg-foreground/25"
        onClick={onClose}
      />

      <div className="relative flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-[10px] border border-border bg-surface shadow-[0_20px_60px_-24px_rgba(0,0,0,0.22)]">
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileJson className="h-4 w-4 text-foreground-muted" strokeWidth={1.75} />
            <h2
              id="paddle-json-import-title"
              className="truncate text-[15px] font-medium text-foreground"
            >
              导入 Paddle JSON
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="grid h-7 w-7 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 text-[12px] leading-relaxed">
          <p className="mb-3 truncate text-[11px] text-foreground-subtle" title={path}>
            {path}
          </p>

          {state.status === "loading" && (
            <p className="text-foreground-muted">正在分析 JSON 结构…</p>
          )}
          {state.status === "error" && (
            <p className="text-destructive" role="alert">
              读取失败：{state.errorMessage ?? "未知错误"}
            </p>
          )}

          {(state.status === "ready" || state.status === "writing") &&
            state.preflight && (
              <div className="flex flex-col gap-4">
                <PreflightSummary
                  preflight={state.preflight}
                  pdfTotal={currentPdf?.pdfTotal}
                />
                <ExportOptionsPanel
                  options={exportOptions}
                  onChange={setExportOptions}
                />
              </div>
            )}
        </div>

        {(state.status === "ready" || state.status === "writing") && (
          <footer className="flex items-center justify-between gap-2 border-t border-border bg-surface-2 px-5 py-3">
            <span
              className={`min-w-0 flex-1 truncate text-[11px] ${
                exportMessage?.startsWith("导出失败")
                  ? "text-destructive"
                  : "text-foreground-subtle"
              }`}
              title={exportMessage ?? undefined}
            >
              {exportMessage ?? ""}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-7 rounded px-3 text-[12px] text-foreground-muted hover:bg-surface hover:text-foreground"
              >
                取消
              </button>
              {currentPdf && (
                <button
                  type="button"
                  onClick={commit}
                  disabled={state.status !== "ready" || !currentFileId}
                  className="h-7 rounded border border-border/60 px-3 text-[12px] text-foreground-muted hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  title={`写入到「${currentPdf.name}」`}
                >
                  写入按页文本
                </button>
              )}
              <button
                type="button"
                onClick={() => void exportReadingMarkdown()}
                disabled={
                  exportingMarkdown ||
                  exportingPdf ||
                  state.status !== "ready" ||
                  !state.imported?.document.pages.length
                }
                className="inline-flex h-7 items-center gap-1.5 rounded border border-border/60 px-3 text-[12px] text-foreground-muted hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FileText className="h-3.5 w-3.5" strokeWidth={1.75} />
                {exportingMarkdown ? "导出中…" : "导出 Markdown"}
              </button>
              <button
                type="button"
                onClick={() => void exportReadingPdf()}
                disabled={
                  exportingPdf ||
                  exportingMarkdown ||
                  state.status !== "ready" ||
                  !state.imported?.document.pages.length
                }
                className="inline-flex h-7 items-center gap-1.5 rounded bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-opacity hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FileDown className="h-3.5 w-3.5" strokeWidth={1.75} />
                {exportingPdf ? "导出中…" : "导出阅读版 PDF"}
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

function PreflightSummary({
  preflight,
  pdfTotal,
}: {
  preflight: PaddleJsonPreflightReport;
  pdfTotal: number | undefined;
}) {
  const labelEntries = useMemo(
    () => Object.entries(preflight.labelCounts).sort((a, b) => b[1] - a[1]),
    [preflight.labelCounts]
  );
  const modelSettingsPretty = useMemo(() => {
    if (
      preflight.modelSettings == null ||
      preflight.modelSettings === undefined
    ) {
      return null;
    }
    try {
      return JSON.stringify(preflight.modelSettings, null, 2);
    } catch {
      return String(preflight.modelSettings);
    }
  }, [preflight.modelSettings]);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="页数" value={preflight.pageCount.toLocaleString()} />
        <Stat label="区块数" value={preflight.blockCount.toLocaleString()} />
        <Stat
          label="区块标签"
          value={Object.keys(preflight.labelCounts).length.toString()}
        />
      </div>

      {pdfTotal != null && pdfTotal !== preflight.pageCount && (
        <div className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            JSON 为 {preflight.pageCount} 页，当前 PDF 为 {pdfTotal} 页。导入后
            JSON 的页码会按其原始页号写入，未匹配的页保持原样。
          </span>
        </div>
      )}

      <div>
        <div className="mb-1 text-[11px] font-medium text-foreground-muted">
          结构字段
        </div>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
          {STRUCTURE_DESCRIPTIONS.map(({ key, label }) => {
            const present = preflight[key] as boolean;
            return (
              <li
                key={key}
                className="flex items-center gap-1.5 text-[12px]"
                title={present ? "结构存在" : "结构缺失"}
              >
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    present ? "bg-success" : "bg-foreground-subtle/40"
                  }`}
                />
                <span
                  className={present ? "text-foreground" : "text-foreground-subtle"}
                >
                  {label}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {labelEntries.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium text-foreground-muted">
            区块标签分布
          </div>
          <ul className="flex flex-wrap gap-1">
            {labelEntries.map(([label, count]) => (
              <li
                key={label}
                className="flex items-center gap-1 rounded bg-surface-2 px-2 py-0.5 text-[11px] tabular-nums"
              >
                <span className="text-foreground">{label}</span>
                <span className="text-foreground-subtle">{count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {preflight.markdownIgnoreLabels.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium text-foreground-muted">
            Markdown 忽略的标签
          </div>
          <p className="text-[12px] text-foreground-subtle">
            {preflight.markdownIgnoreLabels.join("、")}
          </p>
        </div>
      )}

      {modelSettingsPretty && (
        <details className="rounded border border-border/40">
          <summary className="cursor-pointer px-2 py-1 text-[11px] font-medium text-foreground-muted hover:text-foreground">
            模型参数 (model_settings)
          </summary>
          <pre className="max-h-40 overflow-auto bg-surface-2 px-2 py-1 font-mono text-[11px] leading-tight text-foreground">
            {modelSettingsPretty}
          </pre>
        </details>
      )}

      {preflight.warnings.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium text-foreground-muted">
            提示
          </div>
          <ul className="flex flex-col gap-1">
            {preflight.warnings.map((warning, idx) => (
              <li
                key={idx}
                className="flex items-start gap-1.5 text-[12px] text-foreground-muted"
              >
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ExportOptionsPanel({
  options,
  onChange,
}: {
  options: LayoutPdfExportOptions;
  onChange: (next: LayoutPdfExportOptions) => void;
}) {
  const setOption = <K extends keyof LayoutPdfExportOptions>(
    key: K,
    value: LayoutPdfExportOptions[K]
  ) => onChange({ ...options, [key]: value });

  return (
    <div className="rounded border border-border/40 bg-surface px-3 py-2">
      <div className="mb-2 text-[11px] font-medium text-foreground-muted">
        阅读版导出选项
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        <OptionCheck
          label="源文件页锚"
          checked={options.includePageNumber}
          onChange={(v) => setOption("includePageNumber", v)}
        />
        <OptionCheck
          label="脚注"
          checked={options.includeFootnote}
          onChange={(v) => setOption("includeFootnote", v)}
        />
        <OptionCheck
          label="表格"
          checked={options.includeTables}
          onChange={(v) => setOption("includeTables", v)}
        />
        <OptionCheck
          label="旁注"
          checked={options.includeAsideText}
          onChange={(v) => setOption("includeAsideText", v)}
        />
        <OptionCheck
          label="页眉"
          checked={options.includeHeader}
          onChange={(v) => setOption("includeHeader", v)}
        />
        <OptionCheck
          label="页脚"
          checked={options.includeFooter}
          onChange={(v) => setOption("includeFooter", v)}
        />
      </div>
      <p className="mt-2 text-[10.5px] text-foreground-subtle">
        正文图片暂以占位和图注保留，不做联网下载内嵌。
      </p>
    </div>
  );
}

function OptionCheck({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[12px] text-foreground-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="h-3.5 w-3.5 accent-primary"
      />
      <span>{label}</span>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border/40 bg-surface px-3 py-2">
      <div className="text-[10px] tracking-wide text-foreground-subtle">
        {label}
      </div>
      <div className="font-mono text-[14px] font-medium tabular-nums text-foreground">
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

  async function open(): Promise<void> {
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
  }

  // `ipcAnalyzePaddleJson` isn't actually called from the flow — the
  // dialog uses `importPaddleJson` directly because it always needs the
  // full payload anyway. We re-export the symbol so the queue panel can
  // ergonomically lazy-call analyze in the future (e.g. for a quick
  // "compatibility check" without staging an import).
  return { path, open, close: () => setPath(null), analyze: ipcAnalyzePaddleJson };
}
