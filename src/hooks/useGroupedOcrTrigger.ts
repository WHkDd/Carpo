import { useCallback, useMemo, useState } from "react";
import { useStore } from "@/store";
import { pageKey } from "@/store/pageStateSlice";
import { getSecret, startGroupedOcr } from "@/lib/tauri";
import { ACTIVE_PREVIEW_DPI, PROFILE_DPI } from "@/lib/ocr-profile";
import {
  appErrorMessage,
  type ArticleOcrPlan,
  type BlockRef,
  type GroupedOcrRequest,
  type Provider,
  type SecretKey,
} from "@/lib/ipc-types";

const PROVIDER_SECRET_KEY: Record<Provider, SecretKey> = {
  paddleocr: "paddle_token",
  openai: "openai_key",
  openrouter: "openrouter_key",
  openai_compatible: "openai_compatible_key",
};

export interface TriggerState {
  /** True iff there is a current file, at least one article exists, and at
   *  least one article is currently selected. The provider's key presence is
   *  checked at click time only (cheap, but async). */
  ready: boolean;
  /** Most recent validation error, surfaced to the user as a transient banner.
   *  Cleared by the next successful trigger. */
  error: string | null;
  /** True while we're awaiting the backend's `start_grouped_ocr` response.
   *  Once it returns, jobSlice owns the in-flight state. */
  starting: boolean;
  /** How many articles are currently selected — used by the action bar to
   *  label the button. */
  selectedCount: number;
  /** Total articles in the document. */
  totalCount: number;
}

export function useGroupedOcrTrigger() {
  const currentFileId = useStore((s) => s.currentFileId);
  const file = useStore((s) =>
    s.currentFileId ? s.files.find((f) => f.id === s.currentFileId) ?? null : null
  );
  const docState = useStore((s) =>
    s.currentFileId ? s.getDocumentState(s.currentFileId) : null
  );
  const pageStates = useStore((s) => s.pageStates);
  const settings = useStore((s) => s.settings);
  const selectedArticleIds = useStore((s) => s.selectedArticleIds);
  const startJob = useStore((s) => s.startJob);
  const setRecognitionMode = useStore((s) => s.setRecognitionMode);

  const selectedSet = useMemo(
    () => new Set(selectedArticleIds),
    [selectedArticleIds]
  );

  const totalCount = docState?.articles.length ?? 0;
  // Only articles that exist in the doc count toward "selected"; stale ids
  // (e.g. an article got removed mid-selection) are silently ignored.
  const selectedCount = docState
    ? docState.articles.filter((a) => selectedSet.has(a.id)).length
    : 0;

  const ready = (() => {
    if (!currentFileId || !file || !docState) return false;
    if (totalCount === 0) return false;
    if (selectedCount === 0) return false;
    // All selected articles must have at least one block to OCR.
    return docState.articles
      .filter((a) => selectedSet.has(a.id))
      .every((a) => a.blockRefs.length > 0);
  })();

  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const trigger = useCallback(async () => {
    if (!currentFileId || !file || !docState) return;
    if (selectedSet.size === 0) {
      setError("请先选择要识别的报道");
      return;
    }
    setStarting(true);
    try {
      const secretKey = PROVIDER_SECRET_KEY[settings.provider];
      const hasSecret = await getSecret(secretKey);
      if (
        settings.provider === "openai_compatible" &&
        !settings.openai_compatible_base_url
      ) {
        setError("OpenAI 兼容服务尚未配置 base_url —— 请先在设置中填写。");
        return;
      }
      if (!hasSecret) {
        setError(`${settings.provider} 的 API 密钥未找到（Keychain key: ${secretKey}）—— 请在设置中重新保存。`);
        return;
      }

      const articles: ArticleOcrPlan[] = [];
      for (const art of docState.articles) {
        if (!selectedSet.has(art.id)) continue;
        const blocks: BlockRef[] = [];
        for (const ref of art.blockRefs) {
          const ps = pageStates[pageKey(currentFileId, ref.page)];
          const block = ps?.blocks.find((b) => b.id === ref.blockId);
          if (!block) {
            setError(
              `报道${art.num} 引用的块 ${ref.blockId} 在 page ${ref.page} 中已不存在`
            );
            return;
          }
          blocks.push({
            page: ref.page,
            block_id: ref.blockId,
            rect: { x: block.x, y: block.y, width: block.w, height: block.h },
            order: ref.order,
          });
        }
        if (blocks.length === 0) {
          setError(`报道${art.num} 没有任何块`);
          return;
        }
        articles.push({
          id: art.id,
          title: art.title,
          num: art.num,
          blocks,
        });
      }

      if (articles.length === 0) {
        setError("当前选中的报道在文档中已不存在");
        return;
      }

      const profile = PROFILE_DPI[settings.ocr_profile];
      const req: GroupedOcrRequest = {
        file_id: currentFileId,
        path: file.path,
        kind: file.kind,
        preview_dpi: file.kind === "pdf" ? ACTIVE_PREVIEW_DPI : 0,
        ocr_dpi: profile.ocr,
        articles,
        newspaper_name: docState.newspaperName,
        newspaper_date: docState.newspaperDate,
      };

      setError(null);
      setRecognitionMode("grouped");
      const { job_id } = await startGroupedOcr(req);
      startJob({
        jobId: job_id,
        kind: "grouped_ocr",
        fileId: currentFileId,
        newspaperName: docState.newspaperName,
        newspaperDate: docState.newspaperDate,
        requestedArticles: articles.map((a) => ({ id: a.id, title: a.title })),
        label: `准备中… 共 ${articles.length} 篇`,
      });
    } catch (e) {
      setError(appErrorMessage(e));
    } finally {
      setStarting(false);
    }
  }, [currentFileId, file, docState, pageStates, settings, selectedSet, startJob, setRecognitionMode]);

  return {
    state: {
      ready,
      error,
      starting,
      selectedCount,
      totalCount,
    } satisfies TriggerState,
    trigger,
    clearError: () => setError(null),
  };
}
