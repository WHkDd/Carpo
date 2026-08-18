import { useCallback, useState } from "react";
import { useStore } from "@/store";
import { t } from "@/i18n";
import { getSecret, startProofread } from "@/lib/tauri";
import { confirmDestructive } from "@/lib/confirm";
import { enableNotificationsAfterUserAction } from "@/lib/desktop";
import { appErrorMessage, type ProofreadUnit, type SecretKey } from "@/lib/ipc-types";
import {
  isChatProvider,
  proofreadKeyFor,
  resolveProofreadModel,
  resolveProofreadProvider,
  type ProofreadTarget,
} from "@/lib/proofread";
import {
  captureProofreadImages,
  planProofreadImages,
  tooManyImagesMessage,
  MAX_PROOFREAD_IMAGES,
} from "@/lib/proofread-images";
import { usePageBitmapCacheContext } from "./PageBitmapCacheContext";

const CHAT_SECRET_KEY: Record<string, SecretKey> = {
  openai: "openai_key",
  openrouter: "openrouter_key",
  openai_compatible: "openai_compatible_key",
};

/** The text a target currently holds, straight from the live store. */
function targetText(
  state: ReturnType<typeof useStore.getState>,
  fileId: string,
  target: ProofreadTarget
): string {
  if (target.mode === "whole_file") {
    return (
      state.recognizedPages[fileId]?.[target.page]?.text ??
      state.pageOcrTexts[fileId]?.[target.page] ??
      ""
    );
  }
  return state.articleOcrTexts[fileId]?.[target.articleId] ?? "";
}

/** Pure selector: the target the main button would proofread right now, or
 *  null when the current scope has no text. Render subscriptions reduce this
 *  to a boolean (see the hook) — zustand v5 requires referentially stable
 *  snapshots, and this function builds a fresh object per call. The full
 *  value is re-read from `useStore.getState()` right before a start — the
 *  panel flushes its edit debounce first, and a closure over the rendered
 *  value would send the pre-flush text (E2). */
export function selectCurrentProofreadTarget(
  state: ReturnType<typeof useStore.getState>
): ProofreadTarget | null {
  if (!state.currentFileId) return null;
  if (state.recognitionMode === "whole_file") {
    const file = state.files.find((f) => f.id === state.currentFileId);
    const page = file?.currentPage ?? 1;
    const text = targetText(state, state.currentFileId, {
      mode: "whole_file",
      page,
    });
    return text.trim().length > 0 ? { mode: "whole_file", page } : null;
  }
  if (state.selectedArticleIds.length !== 1) return null;
  const articleId = state.selectedArticleIds[0]!;
  const text = state.articleOcrTexts[state.currentFileId]?.[articleId] ?? "";
  return text.trim().length > 0 ? { mode: "grouped", articleId } : null;
}

/** Pure selector: all grouped articles that have text, as targets — the
 *  「校对全部报道」 scope. Empty outside grouped mode. Same fresh-read
 *  contract as `selectCurrentProofreadTarget`, and the same stability rule:
 *  render subscriptions take only `.length`, never the array itself. */
export function selectAllArticleProofreadTargets(
  state: ReturnType<typeof useStore.getState>
): ProofreadTarget[] {
  if (!state.currentFileId || state.recognitionMode !== "grouped") return [];
  const doc = state.getDocumentState(state.currentFileId);
  const texts = state.articleOcrTexts[state.currentFileId] ?? {};
  return doc.articles
    .map((a) => ({ id: a.id, text: texts[a.id] ?? "" }))
    .filter((entry) => entry.text.trim().length > 0)
    .map((entry) => ({ mode: "grouped", articleId: entry.id }));
}

export interface ProofreadTriggerState {
  /** True while awaiting the backend's `start_proofread` response. Once it
   *  returns, `jobSlice` owns the in-flight state. */
  starting: boolean;
  /** Most recent validation error, surfaced inline by the panel. */
  error: string | null;
  /** Whether the main button's scope has proofreadable text right now. */
  hasCurrentTarget: boolean;
  /** How many grouped articles currently have text — the 「校对全部报道」
   *  scope count. 0 outside grouped mode. */
  allArticleTargetCount: number;
}

/**
 * The proofread button's engine. Client-side mirror of the backend's
 * `jobs::proofread::validate`: a chat-capable provider, a model, a key — all
 * checked before the job starts so the failure is a local message, not a
 * progress pill that dies.
 */
export function useProofreadTrigger() {
  const startJob = useStore((s) => s.startJob);
  // Subscribed for rendering (disabled state, scope count) as PRIMITIVES
  // only. zustand v5 hands the selector result straight to
  // `useSyncExternalStore`, whose snapshot must be referentially stable — a
  // selector returning a fresh array/object per call re-renders forever
  // (React #185; the first packaged build of this branch shipped exactly
  // that blank window). A start re-derives the full targets from
  // `useStore.getState()` instead — see E2.
  const hasCurrentTarget = useStore(
    (s) => selectCurrentProofreadTarget(s) !== null
  );
  const allArticleTargetCount = useStore(
    (s) => selectAllArticleProofreadTargets(s).length
  );

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The page bitmaps the canvas already holds. Read-through only — see
  // `captureProofreadImages` for why this must not write to the LRU.
  const cache = usePageBitmapCacheContext();

  const start = useCallback(
    async (fileId: string, targets: ProofreadTarget[]) => {
      // Taken before the first `await`, so a double-click cannot get two
      // attempts past the key probe and the confirm dialog. The `finally`
      // below has to cover every early return in this function — see
      // `claimJobStart`.
      const owner = useStore.getState().claimJobStart("proofread");
      if (owner === null) {
        setError(t("trigger.jobRunning"));
        return;
      }
      setStarting(true);
      try {
        const state = useStore.getState();
        const settingsNow = state.settings;
        const provider = resolveProofreadProvider(settingsNow);

        if (!isChatProvider(provider)) {
          setError(t("settings.proofreadProviderNote"));
          return;
        }
        if (resolveProofreadModel(settingsNow).trim().length === 0) {
          setError(t("proofread.noModel"));
          return;
        }
        if (
          provider === "openai_compatible" &&
          !settingsNow.openai_compatible_base_url
        ) {
          setError(t("trigger.compatBaseUrlMissing"));
          return;
        }
        const secretKey = CHAT_SECRET_KEY[provider];
        if (secretKey) {
          const hasSecret = await getSecret(secretKey);
          if (!hasSecret) {
            setError(
              t("trigger.secretMissing", { provider, key: secretKey })
            );
            return;
          }
        }

        // Re-running over an undecided review would silently throw its
        // verdicts away — ask first (the same native dialog as every other
        // destructive action, not a web confirm).
        const pending = targets.filter(
          (target) =>
            state.proofreadReviews[fileId]?.[proofreadKeyFor(target)]?.status ===
            "pending"
        );
        if (pending.length > 0) {
          const ok = await confirmDestructive({
            title: t("proofread.alreadyPendingTitle"),
            message: t("proofread.alreadyPendingBody"),
            confirmLabel: t("common.confirm"),
          });
          if (!ok) return;
        }

        // Built from a fresh snapshot: the key probe and the pending-review
        // dialog above both await, and an edit that lands during them
        // belongs in the request — the state captured before those awaits
        // would silently send the older text.
        const stateNow = useStore.getState();

        // Proofreading always sends the scan alongside the text, so the image
        // cap — not the unit cap — is what a batch runs into first. Refuse
        // before capturing anything: encoding 40 crops and then having the
        // backend reject the upload would waste the wait and the memory.
        const plans = planProofreadImages(stateNow, fileId, targets);
        if (plans.length > MAX_PROOFREAD_IMAGES) {
          setError(tooManyImagesMessage(plans.length));
          return;
        }
        const file = stateNow.files.find((entry) => entry.id === fileId);
        // A capture failure is not a proofread failure: `captureProofreadImages`
        // logs and omits, and the affected unit goes out as text only.
        const images = file
          ? await captureProofreadImages(plans, { file, cache })
          : new Map<string, string[]>();

        // Two views of the same units, and the difference matters.
        //
        // `trackedUnits` is what the *job record* keeps: it lives in the
        // store for the duration of the job and is mirrored into
        // sessionStorage by `savePendingJob`, where it exists so a refreshed
        // tab can still match the eventual `done` event. Only `key` and
        // `text` are ever read back (the review's `baseText`), while the
        // images would be tens of megabytes of base64 — past the ~5MB
        // sessionStorage quota, so the write would fail and take
        // reconciliation down with it, after stalling the UI serializing it.
        const trackedUnits: ProofreadUnit[] = targets.map((target) => ({
          key: proofreadKeyFor(target),
          text: targetText(stateNow, fileId, target),
        }));
        // `requestUnits` is what goes on the wire, images and all.
        const requestUnits: ProofreadUnit[] = trackedUnits.map((unit) => ({
          ...unit,
          images: images.get(unit.key) ?? [],
        }));

        try {
          setError(null);
          await enableNotificationsAfterUserAction();
          // Carry the *confirmed* settings snapshot in the request: the
          // backend validates and runs exactly this view, so the timing of
          // the settings write-back (E1) cannot change which model runs.
          // The prompt rides along raw — the backend's resolver supplies
          // the language default when it is empty.
          const { job_id } = await startProofread({
            file_id: fileId,
            units: requestUnits,
            provider,
            model: resolveProofreadModel(settingsNow),
            prompt: settingsNow.proofread_prompt,
          });
          const doc = state.getDocumentState(fileId);
          startJob({
            jobId: job_id,
            kind: "proofread",
            fileId,
            newspaperName: doc.newspaperName,
            newspaperDate: doc.newspaperDate,
            units: trackedUnits,
            stage: {
              kind: "proofread_running",
              index: 0,
              count: trackedUnits.length,
            },
          });
        } catch (e) {
          setError(t("proofread.failed", { message: appErrorMessage(e) }));
        }
      } finally {
        setStarting(false);
        useStore.getState().releaseJobStart(owner);
      }
    },
    [startJob, cache]
  );

  /** The split button's main action: proofread the current scope. Targets
   *  are derived from the live store *now*, after the panel has flushed its
   *  edit debounce — a closure over the rendered value would carry the
   *  pre-flush text (or an already-emptied article) into the batch. */
  const triggerCurrent = useCallback(async () => {
    const state = useStore.getState();
    const fileId = state.currentFileId;
    if (!fileId) {
      setError(t("trigger.openFileFirst"));
      return;
    }
    const target = selectCurrentProofreadTarget(state);
    if (!target) {
      setError(
        state.recognitionMode === "whole_file"
          ? t("proofread.noText")
          : t("trigger.selectArticles")
      );
      return;
    }
    await start(fileId, [target]);
  }, [start]);

  /** The dropdown's 「校对全部报道」 scope. Grouped mode only. */
  const triggerAllArticles = useCallback(async () => {
    const state = useStore.getState();
    const fileId = state.currentFileId;
    if (!fileId) return;
    const targets = selectAllArticleProofreadTargets(state);
    if (targets.length === 0) return;
    await start(fileId, targets);
  }, [start]);

  return {
    state: {
      starting,
      error,
      hasCurrentTarget,
      allArticleTargetCount,
    } satisfies ProofreadTriggerState,
    triggerCurrent,
    triggerAllArticles,
    clearError: () => setError(null),
  };
}
