import { useEffect, useRef, useState, type RefObject } from "react";
import { Minus, Plus, RotateCcw, RotateCw } from "lucide-react";
import type { CanvasController } from "@/components/canvas/ImageCanvas";
import { DropMenu } from "@/components/ui/DropMenu";
import { useStore, type AppStore } from "@/store";
import { useT, type Translator } from "@/i18n";
import { DEFAULT_FILE_VIEW } from "@/store/fileViewSlice";
import { clampZoomPercent } from "@/store/uiSlice";
import { isImeCommit } from "@/lib/ime";
import { appErrorMessage } from "@/lib/ipc-types";
import type { OcrProfile, Provider, SecretKey } from "@/lib/ipc-types";
import { rotateImage } from "@/lib/tauri";
import { confirmDestructive } from "@/lib/confirm";
import { ACTIVE_PREVIEW_DPI } from "@/lib/ocr-profile";
import { logError } from "@/lib/runtime";
import { usePageBitmapCacheContext } from "@/hooks/PageBitmapCacheContext";
import { selectJobStartBlocked } from "@/store/jobSlice";

interface StatusBarProps {
  canvasRef: RefObject<CanvasController | null>;
}

function providerLabel(provider: Provider, t: Translator): string {
  switch (provider) {
    case "paddleocr":
      return "PaddleOCR";
    case "openai":
      return "OpenAI";
    case "openrouter":
      return "OpenRouter";
    case "openai_compatible":
      return t("provider.openai_compatible");
  }
}

const PROVIDER_ORDER: Provider[] = [
  "paddleocr",
  "openai",
  "openrouter",
  "openai_compatible",
];

const PROVIDER_SECRET_KEY: Record<Provider, SecretKey> = {
  paddleocr: "paddle_token",
  openai: "openai_key",
  openrouter: "openrouter_key",
  openai_compatible: "openai_compatible_key",
};

function profileLabel(profile: OcrProfile, t: Translator): string {
  return profile === "standard" ? t("profile.standard") : t("profile.fast");
}

const PROFILE_ORDER: OcrProfile[] = ["standard", "fast"];

/** Whether rotating `fileId` would throw away anything the user made: blocks,
 *  articles, or any recognition result. Decides whether to ask first. */
function hasFileWork(s: AppStore, fileId: string): boolean {
  const prefix = `${fileId}::`;
  const hasBlocks = Object.entries(s.pageStates).some(
    ([key, page]) => key.startsWith(prefix) && page.blocks.length > 0
  );
  const nonEmpty = (v: object | undefined) => !!v && Object.keys(v).length > 0;
  return (
    hasBlocks ||
    (s.documentStates[fileId]?.articles.length ?? 0) > 0 ||
    !!s.documentResults[fileId] ||
    nonEmpty(s.articleOcrTexts[fileId]) ||
    nonEmpty(s.pageOcrTexts[fileId]) ||
    nonEmpty(s.recognizedPages[fileId])
  );
}

/** Whether a running batch still has `fileId` queued or in progress. Its plan
 *  snapshotted that file's block rects at batch start, so rotating it now
 *  would send old-frame rects against the rotated pixels. */
function batchHoldsFile(s: AppStore, fileId: string): boolean {
  const batch = s.batchExport;
  if (!batch || (batch.status !== "running" && batch.status !== "cancelling")) {
    return false;
  }
  return batch.items.some(
    (item) =>
      item.fileId === fileId &&
      (item.status === "pending" || item.status === "running")
  );
}

export function StatusBar({ canvasRef }: StatusBarProps) {
  const t = useT();
  const hasFile = useStore((s) => s.currentFileId !== null);
  const settings = useStore((s) => s.settings);
  const provider = settings.provider;
  const ocrProfile = settings.ocr_profile;
  const setProvider = useStore((s) => s.setProvider);
  const setOcrProfile = useStore((s) => s.setOcrProfile);
  const cache = usePageBitmapCacheContext();
  const currentImage = useStore((s) => {
    const file = s.currentFileId
      ? s.files.find((f) => f.id === s.currentFileId)
      : undefined;
    return file && file.kind === "image" && !file.loadError ? file : null;
  });
  const jobBlocked = useStore(selectJobStartBlocked);
  const batchHoldsCurrent = useStore((s) =>
    s.currentFileId ? batchHoldsFile(s, s.currentFileId) : false
  );
  const [rotating, setRotating] = useState(false);
  // Synchronous re-entry guard: `rotating` only flips after the confirm
  // dialog, and a second click while it is open must not start a second
  // rotation from the same, soon-stale path.
  const rotateBusyRef = useRef(false);
  // The stored zoom is fractional; this field only ever shows whole percents.
  const zoomPercent = useStore((s) => {
    if (!s.currentFileId) return DEFAULT_FILE_VIEW.zoomPercent;
    return Math.round(
      s.fileViews[s.currentFileId]?.zoomPercent ??
        DEFAULT_FILE_VIEW.zoomPercent
    );
  });

  const [draftZoom, setDraftZoom] = useState<string>(String(zoomPercent));

  useEffect(() => {
    setDraftZoom(String(zoomPercent));
  }, [zoomPercent]);

  // Credential presence is read from the store, never probed here. This
  // component mounts on every launch, and the old mount-time probe read all
  // four Keychain entries before the `!hasFile` bail-out below — enough to
  // pop a macOS Keychain password prompt over an empty first window. The
  // store only knows about credentials the settings dialog already looked at
  // for its own reasons; `undefined` means "unknown", and unknown providers
  // are neither flagged nor disabled.
  const presence = useStore((s) => s.credentialPresence);
  const isMissing = (p: Provider): boolean =>
    presence[PROVIDER_SECRET_KEY[p]] === false;

  const commitDraft = () => {
    const cleaned = draftZoom.replace(/[^\d]/g, "");
    if (cleaned.length === 0) {
      setDraftZoom(String(zoomPercent));
      return;
    }
    const next = clampZoomPercent(parseInt(cleaned, 10));
    // Blurring an untouched field must not snap 14.3% to the 14 it displays.
    if (next === zoomPercent) {
      setDraftZoom(String(zoomPercent));
      return;
    }
    canvasRef.current?.setPercent(next);
  };

  const rotate = async (clockwise: boolean) => {
    if (!currentImage || rotateBusyRef.current) return;
    rotateBusyRef.current = true;
    const fileId = currentImage.id;
    const path = currentImage.path;
    let owner: string | null = null;
    const { setStatusText, releaseJobStart } = useStore.getState();
    try {
      if (hasFileWork(useStore.getState(), fileId)) {
        const ok = await confirmDestructive({
          title: t("statusBar.rotateConfirmTitle"),
          message: t("statusBar.rotateConfirmMessage"),
          confirmLabel: t("statusBar.rotateConfirm"),
        });
        if (!ok) return;
      }
      // The dialog is async: re-check that the target is still the file on
      // screen, unchanged, and not held by a batch. The job claim below binds
      // to the *current* file, so it must be this one.
      const s = useStore.getState();
      const live = s.files.find((f) => f.id === fileId);
      if (
        s.currentFileId !== fileId ||
        !live ||
        live.path !== path ||
        batchHoldsFile(s, fileId)
      ) {
        return;
      }
      // Hold the job slot for the duration: an OCR run started mid-rotation
      // would read one orientation and write results onto the other.
      owner = s.claimJobStart("rotate");
      if (!owner) return;
      setRotating(true);
      setStatusText(t("statusBar.rotating"));
      const nextPath = await rotateImage(path, clockwise);
      // Committed on the backend (the server has already swapped its copy):
      // switch the entry over now, before any preview fetch that could fail,
      // and drop the old bitmap so nothing — canvas or proofread capture —
      // keeps reading old-orientation pixels. `usePdfPageSync` reloads.
      cache.delete(fileId, 1, ACTIVE_PREVIEW_DPI);
      useStore.getState().replaceRotatedImage(fileId, nextPath);
      setStatusText("");
    } catch (err) {
      const message = appErrorMessage(err);
      void logError(`rotate failed: ${path}: ${message}`);
      setStatusText(t("statusBar.rotateFailed", { message }));
    } finally {
      if (owner) releaseJobStart(owner);
      setRotating(false);
      rotateBusyRef.current = false;
    }
  };

  if (!hasFile) return null;

  return (
    <footer className="absolute bottom-[2.5px] left-2 z-10 flex h-7 items-center gap-1 rounded-lg border border-border/60 bg-background/75 px-1 text-[12px] text-foreground-muted">
      <DropMenu
        ariaLabel={t("statusBar.provider")}
        triggerLabel={providerLabel(provider, t)}
        triggerHint={
          isMissing(provider) ? t("statusBar.notConfigured") : undefined
        }
        triggerClassName="font-semibold text-foreground hover:bg-foreground/[0.07] aria-expanded:bg-foreground/[0.07]"
        items={PROVIDER_ORDER.map((p) => ({
          key: p,
          label: providerLabel(p, t),
          selected: p === provider,
          // Never disabled: an unconfigured provider is still a legitimate
          // thing to select (the backend validates the credential when OCR
          // actually starts and says so), and disabling on unknown presence
          // would lock the user out of a provider we simply never checked.
          hint: isMissing(p) ? t("statusBar.notConfigured") : undefined,
        }))}
        onSelect={(p) => setProvider(p)}
      />
      <DropMenu
        ariaLabel={t("statusBar.profile")}
        triggerLabel={profileLabel(ocrProfile, t)}
        triggerClassName="text-foreground hover:bg-foreground/[0.07] aria-expanded:bg-foreground/[0.07]"
        items={PROFILE_ORDER.map((p) => ({
          key: p,
          label: profileLabel(p, t),
          selected: p === ocrProfile,
        }))}
        onSelect={(p) => setOcrProfile(p)}
      />
      <span className="h-3 w-px bg-border" aria-hidden />
      <button
        type="button"
        aria-label={t("statusBar.zoomOut")}
        onClick={() => canvasRef.current?.zoomOut()}
        className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-foreground/[0.07] hover:text-foreground active:bg-foreground/[0.12]"
      >
        <Minus className="h-3 w-3" strokeWidth={1.8} />
      </button>
      <div className="flex h-6 items-center rounded-md px-1 transition-colors focus-within:bg-foreground/[0.07]">
        <input
          value={draftZoom}
          onChange={(e) => setDraftZoom(e.target.value.replace(/[^\d]/g, ""))}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (isImeCommit(e)) return;
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setDraftZoom(String(zoomPercent));
              e.currentTarget.blur();
            }
          }}
          inputMode="numeric"
          aria-label={t("statusBar.zoomPercent")}
          style={{ width: `calc(${Math.max(1, draftZoom.length)}ch + 2px)` }}
          className="h-6 bg-transparent text-right font-mono text-[11px] font-semibold text-foreground tabular-nums outline-none"
        />
        <span className="pl-1 font-mono text-[10px] text-foreground-subtle">
          %
        </span>
      </div>
      <button
        type="button"
        aria-label={t("statusBar.zoomIn")}
        onClick={() => canvasRef.current?.zoomIn()}
        className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-foreground/[0.07] hover:text-foreground active:bg-foreground/[0.12]"
      >
        <Plus className="h-3 w-3" strokeWidth={1.8} />
      </button>
      <button
        type="button"
        onClick={() => canvasRef.current?.fit()}
        className="h-6 rounded-md px-1.5 text-[11px] font-medium text-foreground-muted transition-colors hover:bg-foreground/[0.07] hover:text-foreground active:bg-foreground/[0.12]"
      >
        {t("statusBar.fit")}
      </button>
      {currentImage && (
        <>
          <span className="h-3 w-px bg-border" aria-hidden />
          <button
            type="button"
            aria-label={t("statusBar.rotateLeft")}
            title={t("statusBar.rotateLeft")}
            disabled={rotating || jobBlocked || batchHoldsCurrent}
            onClick={() => void rotate(false)}
            className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-foreground/[0.07] hover:text-foreground active:bg-foreground/[0.12] disabled:pointer-events-none disabled:opacity-40"
          >
            <RotateCcw className="h-3 w-3" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            aria-label={t("statusBar.rotateRight")}
            title={t("statusBar.rotateRight")}
            disabled={rotating || jobBlocked || batchHoldsCurrent}
            onClick={() => void rotate(true)}
            className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-foreground/[0.07] hover:text-foreground active:bg-foreground/[0.12] disabled:pointer-events-none disabled:opacity-40"
          >
            <RotateCw className="h-3 w-3" strokeWidth={1.8} />
          </button>
        </>
      )}
    </footer>
  );
}
