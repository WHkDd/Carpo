import { useCallback, useMemo, useState } from "react";
import { useStore } from "@/store";
import { t } from "@/i18n";
import { pageKey } from "@/store/pageStateSlice";
import { getSecret, startGroupedOcr } from "@/lib/tauri";
import { ACTIVE_PREVIEW_DPI } from "@/lib/ocr-profile";
import { enableNotificationsAfterUserAction } from "@/lib/desktop";
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
      setError(t("trigger.selectArticles"));
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
        setError(t("trigger.compatBaseUrlMissing"));
        return;
      }
      if (!hasSecret) {
        setError(
          t("trigger.secretMissing", {
            provider: settings.provider,
            key: secretKey,
          })
        );
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
              t("trigger.blockMissing", {
                num: art.num,
                blockId: ref.blockId,
                page: ref.page,
              })
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
          setError(t("trigger.articleNoBlocks", { num: art.num }));
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
        setError(t("trigger.articlesGone"));
        return;
      }

      const req: GroupedOcrRequest = {
        file_id: currentFileId,
        path: file.path,
        kind: file.kind,
        preview_dpi: file.kind === "pdf" ? ACTIVE_PREVIEW_DPI : 0,
        // OCR-grade DPI is derived backend-side from `settings.ocr_profile`
        // (see `OcrProfile::ocr_dpi` in Rust). The field is kept on the wire
        // for backward compatibility but the value is ignored.
        ocr_dpi: 0,
        articles,
        newspaper_name: docState.newspaperName,
        newspaper_date: docState.newspaperDate,
      };

      setError(null);
      setRecognitionMode("grouped");
      await enableNotificationsAfterUserAction();
      const { job_id } = await startGroupedOcr(req);
      startJob({
        jobId: job_id,
        kind: "grouped_ocr",
        fileId: currentFileId,
        newspaperName: docState.newspaperName,
        newspaperDate: docState.newspaperDate,
        requestedArticles: articles.map((a) => ({ id: a.id, title: a.title })),
        stage: { kind: "preparing_articles", total: articles.length },
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
