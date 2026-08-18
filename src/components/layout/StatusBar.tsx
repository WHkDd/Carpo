import { useEffect, useState, type RefObject } from "react";
import { Minus, Plus } from "lucide-react";
import type { CanvasController } from "@/components/canvas/ImageCanvas";
import { DropMenu } from "@/components/ui/DropMenu";
import { useStore } from "@/store";
import { useT, type Translator } from "@/i18n";
import { DEFAULT_FILE_VIEW } from "@/store/fileViewSlice";
import { clampZoomPercent } from "@/store/uiSlice";
import { isImeCommit } from "@/lib/ime";
import type { OcrProfile, Provider, SecretKey } from "@/lib/ipc-types";

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

export function StatusBar({ canvasRef }: StatusBarProps) {
  const t = useT();
  const hasFile = useStore((s) => s.currentFileId !== null);
  const settings = useStore((s) => s.settings);
  const provider = settings.provider;
  const ocrProfile = settings.ocr_profile;
  const setProvider = useStore((s) => s.setProvider);
  const setOcrProfile = useStore((s) => s.setOcrProfile);
  const zoomPercent = useStore((s) => {
    if (!s.currentFileId) return DEFAULT_FILE_VIEW.zoomPercent;
    return (
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
    canvasRef.current?.setPercent(next);
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
        triggerClassName="font-semibold text-foreground"
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
        triggerClassName="text-foreground"
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
        className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground active:bg-surface-overlay"
      >
        <Minus className="h-3 w-3" strokeWidth={1.8} />
      </button>
      <div className="flex h-6 items-center rounded-md px-1 transition-colors focus-within:bg-surface-2">
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
        className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground active:bg-surface-overlay"
      >
        <Plus className="h-3 w-3" strokeWidth={1.8} />
      </button>
      <button
        type="button"
        onClick={() => canvasRef.current?.fit()}
        className="h-6 rounded-md px-1.5 text-[11px] font-medium text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground active:bg-surface-overlay"
      >
        {t("statusBar.fit")}
      </button>
    </footer>
  );
}
