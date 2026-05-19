import { useCallback, useMemo, useState } from "react";
import { useStore } from "@/store";
import { getSecret, startWholeFileOcr } from "@/lib/tauri";
import {
  PageRangeError,
  parsePageRangePlan,
  type PageRangePlan,
} from "@/lib/page-range";
import {
  appErrorMessage,
  type Provider,
  type SecretKey,
  type WholeFileOcrRequest,
} from "@/lib/ipc-types";

const PROVIDER_SECRET_KEY: Record<Provider, SecretKey> = {
  paddleocr: "paddle_token",
  openai: "openai_key",
  openrouter: "openrouter_key",
  openai_compatible: "openai_compatible_key",
};

export interface WholeFileTriggerState {
  /** Whether a click would be accepted. False when no file is open, no
   *  active job slot is free, or the range is malformed. Provider-key
   *  presence is *not* checked here — that's an async probe done at click
   *  time. */
  ready: boolean;
  /** Most recent validation error, surfaced to the user as an inline note.
   *  Cleared by the next successful trigger. */
  error: string | null;
  /** True while we're awaiting the backend's `start_whole_file_ocr` response.
   *  Once it returns, `jobSlice` owns the in-flight state. */
  starting: boolean;
  /** Number of pages that will be OCR'd with the current range. */
  pageCount: number;
  /** Total page count of the active file (1 for images and single-page
   *  PDFs). */
  totalPages: number;
  /** Raw range input stored for the active file. Empty means all pages. */
  rangeInput: string;
  /** Effective normalized range plan. Null only when no file is open. */
  rangePlan: PageRangePlan | null;
  /** Immediate validation error for the range input. */
  rangeError: string | null;
  /** `true` if the active file is a PDF with more than one page — used by
   *  the Toolbar to decide whether to render the range chip. */
  showRange: boolean;
}

export function useWholeFileOcrTrigger() {
  const currentFileId = useStore((s) => s.currentFileId);
  const file = useStore((s) =>
    s.currentFileId ? s.files.find((f) => f.id === s.currentFileId) ?? null : null
  );
  const docState = useStore((s) =>
    s.currentFileId ? s.getDocumentState(s.currentFileId) : null
  );
  const settings = useStore((s) => s.settings);
  const rangeInput = useStore((s) =>
    s.currentFileId ? s.wholeFileRange[s.currentFileId] ?? "" : ""
  );
  const startJob = useStore((s) => s.startJob);

  const totalPages = file
    ? file.kind === "pdf"
      ? Math.max(1, file.pdfTotal ?? 1)
      : 1
    : 0;
  const rangeState = useMemo(() => {
    if (!file) {
      return { plan: null, error: null };
    }
    try {
      return {
        plan: parsePageRangePlan(file.kind === "pdf" ? rangeInput : "", totalPages),
        error: null,
      };
    } catch (e) {
      return {
        plan: null,
        error: e instanceof PageRangeError ? e.message : appErrorMessage(e),
      };
    }
  }, [file, rangeInput, totalPages]);
  const pages = useMemo(() => rangeState.plan?.pages ?? [], [rangeState.plan]);
  const pageCount = pages.length;

  const showRange = !!file && file.kind === "pdf" && totalPages > 1;

  const ready = !!file && pageCount > 0 && rangeState.error === null;

  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const trigger = useCallback(async () => {
    if (!currentFileId || !file) {
      setError("请先打开一个文件");
      return;
    }
    if (pages.length === 0) {
      setError(rangeState.error ?? "没有可识别的页面");
      return;
    }
    if (rangeState.error !== null) {
      setError(rangeState.error);
      return;
    }
    setStarting(true);
    try {
      if (
        settings.provider === "openai_compatible" &&
        !settings.openai_compatible_base_url
      ) {
        setError("OpenAI 兼容服务尚未配置 base_url —— 请先在设置中填写。");
        return;
      }
      const secretKey = PROVIDER_SECRET_KEY[settings.provider];
      const hasSecret = await getSecret(secretKey);
      if (!hasSecret) {
        setError(
          `${settings.provider} 的 API 密钥未找到（Keychain key: ${secretKey}）—— 请在设置中重新保存。`
        );
        return;
      }

      const newspaperName = docState?.newspaperName ?? "";
      const newspaperDate = docState?.newspaperDate ?? "";
      const req: WholeFileOcrRequest = {
        file_id: currentFileId,
        path: file.path,
        kind: file.kind,
        pages,
        // OCR-grade DPI is backend-derived (see `OcrProfile::ocr_dpi` in
        // Rust); kept on the wire for backward compatibility only.
        ocr_dpi: 0,
        newspaper_name: newspaperName,
        newspaper_date: newspaperDate,
      };

      setError(null);
      const { job_id } = await startWholeFileOcr(req);
      startJob({
        jobId: job_id,
        kind: "whole_file",
        fileId: currentFileId,
        newspaperName,
        newspaperDate,
        requestedPages: pages,
        label: `准备中… 共 ${pages.length} 页`,
      });
    } catch (e) {
      setError(appErrorMessage(e));
    } finally {
      setStarting(false);
    }
  }, [currentFileId, file, docState, pages, rangeState.error, settings, startJob]);

  return {
    state: {
      ready,
      error,
      starting,
      pageCount,
      totalPages,
      rangeInput,
      rangePlan: rangeState.plan,
      rangeError: rangeState.error,
      showRange,
    } satisfies WholeFileTriggerState,
    trigger,
    clearError: () => setError(null),
  };
}
