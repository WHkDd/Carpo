import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, Minus, Plus } from "lucide-react";
import type { CanvasController } from "@/components/canvas/ImageCanvas";
import { useStore } from "@/store";
import { DEFAULT_FILE_VIEW } from "@/store/fileViewSlice";
import { clampZoomPercent } from "@/store/uiSlice";
import { getSecret as ipcGetSecret } from "@/lib/tauri";
import type { OcrProfile, Provider, SecretKey } from "@/lib/ipc-types";

interface StatusBarProps {
  canvasRef: RefObject<CanvasController | null>;
}

const PROVIDER_LABEL: Record<Provider, string> = {
  paddleocr: "PaddleOCR",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  openai_compatible: "OpenAI 兼容",
};

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

const PROFILE_LABEL: Record<OcrProfile, string> = {
  standard: "标准",
  fast: "快速",
};

const PROFILE_ORDER: OcrProfile[] = ["standard", "fast"];

export function StatusBar({ canvasRef }: StatusBarProps) {
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

  // Probe Keychain so the provider menu can mark which entries are wired up.
  // Re-runs whenever settings mutate (settings dialog Save touches the slice
  // even when only secrets changed, since the dialog always writes settings).
  const [secretPresent, setSecretPresent] = useState<Record<Provider, boolean>>({
    paddleocr: false,
    openai: false,
    openrouter: false,
    openai_compatible: false,
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        PROVIDER_ORDER.map(async (p) => {
          try {
            return [p, await ipcGetSecret(PROVIDER_SECRET_KEY[p])] as const;
          } catch {
            return [p, false] as const;
          }
        })
      );
      if (cancelled) return;
      setSecretPresent(
        Object.fromEntries(entries) as Record<Provider, boolean>
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [settings]);

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
        ariaLabel="OCR 服务商"
        triggerLabel={PROVIDER_LABEL[provider]}
        triggerClassName="font-semibold text-foreground"
        items={PROVIDER_ORDER.map((p) => ({
          key: p,
          label: PROVIDER_LABEL[p],
          selected: p === provider,
          disabled: !secretPresent[p] && p !== provider,
          hint: secretPresent[p] ? undefined : "未配置",
        }))}
        onSelect={(p) => setProvider(p)}
      />
      <DropMenu
        ariaLabel="OCR 模式"
        triggerLabel={PROFILE_LABEL[ocrProfile]}
        triggerClassName="text-foreground"
        items={PROFILE_ORDER.map((p) => ({
          key: p,
          label: PROFILE_LABEL[p],
          selected: p === ocrProfile,
        }))}
        onSelect={(p) => setOcrProfile(p)}
      />
      <span className="h-3 w-px bg-border" aria-hidden />
      <button
        type="button"
        aria-label="缩小"
        onClick={() => canvasRef.current?.zoomOut()}
        className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        <Minus className="h-3 w-3" strokeWidth={1.8} />
      </button>
      <div className="flex h-6 items-center rounded-md px-1 transition-colors focus-within:bg-surface-2">
        <input
          value={draftZoom}
          onChange={(e) => setDraftZoom(e.target.value.replace(/[^\d]/g, ""))}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setDraftZoom(String(zoomPercent));
              e.currentTarget.blur();
            }
          }}
          inputMode="numeric"
          aria-label="缩放百分比"
          style={{ width: `calc(${Math.max(1, draftZoom.length)}ch + 2px)` }}
          className="h-6 bg-transparent text-right font-mono text-[11px] font-semibold text-foreground tabular-nums outline-none"
        />
        <span className="pl-1 font-mono text-[10px] text-foreground-subtle">
          %
        </span>
      </div>
      <button
        type="button"
        aria-label="放大"
        onClick={() => canvasRef.current?.zoomIn()}
        className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        <Plus className="h-3 w-3" strokeWidth={1.8} />
      </button>
      <button
        type="button"
        onClick={() => canvasRef.current?.fit()}
        className="h-6 rounded-md px-1.5 text-[11px] font-medium text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        适应
      </button>
    </footer>
  );
}

interface DropMenuItem<T extends string> {
  key: T;
  label: string;
  selected?: boolean;
  disabled?: boolean;
  hint?: string;
}

interface DropMenuProps<T extends string> {
  ariaLabel: string;
  triggerLabel: string;
  triggerClassName?: string;
  items: DropMenuItem<T>[];
  onSelect: (key: T) => void;
}

function DropMenu<T extends string>({
  ariaLabel,
  triggerLabel,
  triggerClassName = "",
  items,
  onSelect,
}: DropMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-6 items-center gap-0.5 rounded px-1 transition-colors hover:bg-surface-2 ${triggerClassName}`}
      >
        <span>{triggerLabel}</span>
        <ChevronDown
          className="h-3 w-3 text-foreground-subtle"
          strokeWidth={1.8}
        />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-20 mb-1 min-w-[160px] rounded-md border border-border/70 bg-background p-1 shadow-md"
        >
          {items.map((it) => {
            const disabled = it.disabled === true;
            return (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  onSelect(it.key);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-left text-[12px] transition-colors ${
                  disabled
                    ? "cursor-default text-foreground-subtle"
                    : "text-foreground hover:bg-surface-2"
                } ${it.selected ? "bg-surface-2" : ""}`}
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
            );
          })}
        </div>
      )}
    </div>
  );
}
