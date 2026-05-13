import { useCallback, useMemo, useState } from "react";
import { useStore } from "@/store";
import { getSecret, startWholeFileOcr } from "@/lib/tauri";
import { PROFILE_DPI } from "@/lib/ocr-profile";
import {
  appErrorMessage,
  type Provider,
  type SecretKey,
  type WholeFileOcrRequest,
} from "@/lib/ipc-types";
import type { WholeFileRange } from "@/store/pageStateSlice";

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
  /** Effective range. `null` means "full range" — i.e. use [1..totalPages]. */
  range: WholeFileRange | null;
  /** `true` if the active file is a PDF with more than one page — used by
   *  the Toolbar to decide whether to render the range chip. */
  showRange: boolean;
}

/** Default range when no custom range is set: the full page list. Images and
 *  single-page PDFs always resolve to `[1]`. */
function effectiveRange(
  file: { kind: "image" | "pdf"; pdfTotal?: number } | null,
  custom: WholeFileRange | null
): WholeFileRange | null {
  if (!file) return null;
  const total = file.kind === "pdf" ? Math.max(1, file.pdfTotal ?? 1) : 1;
  if (custom === null) return null;
  // Re-clamp to the live total so a stale stored range from a re-opened file
  // can't ask for nonexistent pages.
  const from = Math.min(total, Math.max(1, Math.floor(custom.from)));
  const to = Math.min(total, Math.max(from, Math.floor(custom.to)));
  if (from === 1 && to === total) return null;
  return { from, to };
}

function pagesFromRange(totalPages: number, range: WholeFileRange | null): number[] {
  if (range === null) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  return Array.from(
    { length: range.to - range.from + 1 },
    (_, i) => range.from + i
  );
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
  const customRange = useStore((s) =>
    s.currentFileId ? s.wholeFileRange[s.currentFileId] ?? null : null
  );
  const startJob = useStore((s) => s.startJob);

  const range = useMemo(
    () => effectiveRange(file, customRange ?? null),
    [file, customRange]
  );

  const totalPages = file
    ? file.kind === "pdf"
      ? Math.max(1, file.pdfTotal ?? 1)
      : 1
    : 0;
  const pages = useMemo(
    () => (file ? pagesFromRange(totalPages, range) : []),
    [file, totalPages, range]
  );
  const pageCount = pages.length;

  const showRange = !!file && file.kind === "pdf" && totalPages > 1;

  const ready = !!file && pageCount > 0;

  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const trigger = useCallback(async () => {
    if (!currentFileId || !file) {
      setError("请先打开一个文件");
      return;
    }
    if (pages.length === 0) {
      setError("没有可识别的页面");
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

      const profile = PROFILE_DPI[settings.ocr_profile];
      const newspaperName = docState?.newspaperName ?? "";
      const newspaperDate = docState?.newspaperDate ?? "";
      const req: WholeFileOcrRequest = {
        file_id: currentFileId,
        path: file.path,
        kind: file.kind,
        pages,
        ocr_dpi: profile.ocr,
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
  }, [currentFileId, file, docState, pages, settings, startJob]);

  return {
    state: {
      ready,
      error,
      starting,
      pageCount,
      totalPages,
      range,
      showRange,
    } satisfies WholeFileTriggerState,
    trigger,
    clearError: () => setError(null),
  };
}
