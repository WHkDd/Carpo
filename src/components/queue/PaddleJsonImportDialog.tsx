import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import { AlertTriangle, FileJson, X } from "lucide-react";
import { appErrorMessage } from "@/lib/ipc-types";
import {
  analyzePaddleJson as ipcAnalyzePaddleJson,
  importPaddleJson as ipcImportPaddleJson,
} from "@/lib/tauri";
import type {
  PaddleJsonImport,
  PaddleJsonPreflightReport,
} from "@/lib/layout-document";
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

type Target = "current" | "preflight_only";

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

export function PaddleJsonImportDialog({
  open,
  path,
  onClose,
}: PaddleJsonImportDialogProps) {
  const [state, setState] = useState<DialogState>({ status: "loading" });
  const [target, setTarget] = useState<Target>("current");

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

  // Default target switches based on whether a file is open. The user can
  // still override (e.g. "preflight_only" against an open PDF) — we just
  // pick the most useful default.
  useEffect(() => {
    if (open) setTarget(currentPdf ? "current" : "preflight_only");
  }, [open, currentPdf]);

  const pageCount = state.preflight?.pageCount ?? 0;
  const totalPagesMismatch = useMemo(() => {
    if (!currentPdf?.pdfTotal || !state.preflight) return false;
    return state.preflight.pageCount !== currentPdf.pdfTotal;
  }, [currentPdf?.pdfTotal, state.preflight]);

  function commit() {
    if (state.status !== "ready" || !state.imported) return;
    if (target === "preflight_only") {
      onClose();
      return;
    }
    if (!currentFileId) {
      // Defensive: should be unreachable because the radio disables this
      // target without a file. Fall through to preflight-only.
      onClose();
      return;
    }
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
              <PreflightSummary
                preflight={state.preflight}
                pdfTotal={currentPdf?.pdfTotal}
              />
            )}
        </div>

        {(state.status === "ready" || state.status === "writing") && (
          <footer className="flex flex-col gap-2 border-t border-border bg-surface-2 px-5 py-3">
            <fieldset className="flex flex-col gap-1.5 text-[12px]">
              <legend className="mb-1 text-[11px] text-foreground-muted">
                导入目标
              </legend>
              <label
                className={`flex cursor-pointer items-start gap-2 ${
                  currentPdf ? "" : "opacity-50"
                }`}
              >
                <input
                  type="radio"
                  name="paddle-json-target"
                  value="current"
                  checked={target === "current"}
                  onChange={() => setTarget("current")}
                  disabled={!currentPdf}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  {currentPdf ? (
                    <>
                      关联到当前文件「
                      <span className="font-medium text-foreground">
                        {currentPdf.name}
                      </span>
                      」
                      {currentPdf.pdfTotal && currentPdf.pdfTotal > 1 && (
                        <span className="text-foreground-subtle">
                          {" "}
                          · {currentPdf.pdfTotal} 页
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-foreground-subtle">
                      未打开 PDF，无法关联
                    </span>
                  )}
                  {totalPagesMismatch && currentPdf?.pdfTotal && (
                    <span className="ml-1 text-[11px] text-amber-500">
                      （JSON {pageCount} 页与 PDF {currentPdf.pdfTotal} 页不一致）
                    </span>
                  )}
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="paddle-json-target"
                  value="preflight_only"
                  checked={target === "preflight_only"}
                  onChange={() => setTarget("preflight_only")}
                  className="mt-0.5"
                />
                <span>仅查看预检结果，不写入识别文本</span>
              </label>
            </fieldset>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="h-7 rounded px-3 text-[12px] text-foreground-muted hover:bg-surface hover:text-foreground"
              >
                取消
              </button>
              <button
                type="button"
                onClick={commit}
                disabled={
                  state.status !== "ready" ||
                  (target === "current" && !currentFileId)
                }
                className="h-7 rounded bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-opacity hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {target === "current" ? "导入并写入按页文本" : "完成"}
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
  const labelEntries = Object.entries(preflight.labelCounts).sort(
    (a, b) => b[1] - a[1]
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
        <div className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200/90">
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
                    present ? "bg-emerald-400" : "bg-foreground-subtle/40"
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
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border/40 bg-surface px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-foreground-subtle">
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
