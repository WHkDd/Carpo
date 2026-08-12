import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, Minus, Plus } from "lucide-react";
import type { CanvasController } from "@/components/canvas/ImageCanvas";
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

interface DropMenuItem<T extends string> {
  key: T;
  label: string;
  selected?: boolean;
  hint?: string;
}

interface DropMenuProps<T extends string> {
  ariaLabel: string;
  triggerLabel: string;
  triggerHint?: string;
  triggerClassName?: string;
  items: DropMenuItem<T>[];
  onSelect: (key: T) => void;
}

function DropMenu<T extends string>({
  ariaLabel,
  triggerLabel,
  triggerHint,
  triggerClassName = "",
  items,
  onSelect,
}: DropMenuProps<T>) {
  const [open, setOpen] = useState(false);
  // Roving focus index into `items`. A native menu moves a single focused
  // item with the arrow keys rather than making every entry a tab stop.
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const openAt = (index: number) => {
    setActiveIndex(index);
    setOpen(true);
  };

  // Returning focus to the trigger is what makes Escape and select feel like
  // a menu instead of a popover: focus never falls back to <body>.
  const closeAndRestore = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const selectedIndex = Math.max(
    0,
    items.findIndex((it) => it.selected)
  );

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeAndRestore();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(items.length - 1);
    } else if (e.key === "Tab") {
      // Tab out of an open menu closes it, matching platform menus.
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openAt(selectedIndex))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openAt(e.key === "ArrowDown" ? 0 : items.length - 1);
          }
        }}
        className={`flex h-6 items-center gap-0.5 rounded px-1 transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${triggerClassName}`}
      >
        <span>{triggerLabel}</span>
        {triggerHint && (
          <span className="ml-1 rounded bg-destructive/10 px-1 py-0.5 text-[10px] font-normal text-destructive">
            {triggerHint}
          </span>
        )}
        <ChevronDown
          className="h-3 w-3 text-foreground-subtle"
          strokeWidth={1.8}
        />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={onMenuKeyDown}
          className="absolute bottom-full left-0 z-20 mb-1 min-w-[160px] rounded-md border border-border/70 bg-background p-1 shadow-md"
        >
          {items.map((it, index) => (
            <button
              key={it.key}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={it.selected === true}
              tabIndex={index === activeIndex ? 0 : -1}
              onClick={() => {
                onSelect(it.key);
                closeAndRestore();
              }}
              className={`flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-left text-[12px] text-foreground transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${
                it.selected ? "bg-surface-2" : ""
              }`}
            >
              <span className={it.selected ? "font-medium" : ""}>
                {it.label}
              </span>
              {it.hint && (
                <span className="text-[10px] text-foreground-subtle">
                  {it.hint}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
