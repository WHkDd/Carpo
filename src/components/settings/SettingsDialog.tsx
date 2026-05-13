import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderOpen, RefreshCw, X } from "lucide-react";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import { useStore } from "@/store";
import { DEFAULT_SETTINGS } from "@/store/settingsSlice";
import {
  deleteSecret as ipcDeleteSecret,
  getSecret as ipcGetSecret,
  listProviderModels as ipcListProviderModels,
  openLogDir as ipcOpenLogDir,
  setSecret as ipcSetSecret,
  setSettings as ipcSetSettings,
} from "@/lib/tauri";
import type {
  NonSecretSettings,
  Provider,
  SecretKey,
} from "@/lib/ipc-types";
import { appErrorMessage } from "@/lib/ipc-types";

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

const PROVIDER_NOTE: Record<Provider, string> = {
  paddleocr:
    "百度 AI Studio 异步 OCR jobs API。Token 存于系统 Keychain，URL/模型存于本地配置。",
  openai:
    "OpenAI Vision 模型（GPT-4o 等）。API Key 存于系统 Keychain，不会写入磁盘配置文件。",
  openrouter:
    "通过 OpenRouter 转发到 Claude / Gemini / DeepSeek 等模型。API Key 存于系统 Keychain。",
  openai_compatible:
    "用户自填 Base URL 的 OpenAI 兼容端点（Claude / Gemini 代理、本地 vLLM 等）。Key 存于 Keychain。",
};

type TabId = Provider | "prompt";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const committed = useStore((s) => s.settings);
  const setCommitted = useStore((s) => s.setSettings);

  const [draft, setDraft] = useState<NonSecretSettings>(committed);
  const [tab, setTab] = useState<TabId>(committed.provider);
  const [secretPresent, setSecretPresent] = useState<Record<SecretKey, boolean>>({
    paddle_token: false,
    openai_key: false,
    openrouter_key: false,
    openai_compatible_key: false,
  });
  /** Keyed by SecretKey: blank means "no edit"; non-blank means user typed a
   *  new value and we'll send it on save. `null` means user clicked 删除 — we
   *  fire delete_secret on save. */
  const [secretEdits, setSecretEdits] = useState<
    Partial<Record<SecretKey, string | null>>
  >({});
  const [revealedSecrets, setRevealedSecrets] = useState<
    Partial<Record<SecretKey, boolean>>
  >({});
  const [modelLists, setModelLists] = useState<Partial<Record<Provider, string[]>>>({
    paddleocr: ["PaddleOCR-VL", "PaddleOCR-VL-1.5"],
  });
  const [refreshing, setRefreshing] = useState<Provider | null>(null);
  const [refreshError, setRefreshError] = useState<Partial<Record<Provider, string>>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset draft + tab + presence whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setDraft(committed);
    setTab(committed.provider);
    setSecretEdits({});
    setRevealedSecrets({});
    setRefreshError({});
    setSaveError(null);
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        (Object.values(PROVIDER_SECRET_KEY) as SecretKey[]).map(async (k) => {
          try {
            return [k, await ipcGetSecret(k)] as const;
          } catch {
            return [k, false] as const;
          }
        })
      );
      if (cancelled) return;
      setSecretPresent(Object.fromEntries(entries) as Record<SecretKey, boolean>);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, committed]);

  // Esc to close, ⌘S to save.
  const trySave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // Persist all secret edits first so even if non-secret save fails the
      // Keychain reflects the user's intent.
      for (const [key, value] of Object.entries(secretEdits) as Array<
        [SecretKey, string | null]
      >) {
        if (value === null) {
          await ipcDeleteSecret(key);
        } else if (value.length > 0) {
          await ipcSetSecret(key, value);
        }
      }
      await ipcSetSettings(draft);
      setCommitted(draft);
      onClose();
    } catch (e) {
      setSaveError(appErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [draft, secretEdits, setCommitted, onClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void trySave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, trySave]);

  const refreshModels = useCallback(
    async (provider: Provider) => {
      setRefreshing(provider);
      setRefreshError((prev) => ({ ...prev, [provider]: undefined }));
      try {
        // Use the draft state (and any just-typed secret) so the user
        // doesn't have to hit Save before refreshing — this matters for
        // openai_compatible where base_url is required to know what to
        // poll, and for any provider when the user is configuring a key
        // for the first time.
        const probeSettings: NonSecretSettings = { ...draft, provider };
        const secretEdit = secretEdits[PROVIDER_SECRET_KEY[provider]];
        const secret =
          typeof secretEdit === "string" && secretEdit.length > 0
            ? secretEdit
            : undefined;
        const models = await ipcListProviderModels({
          settings: probeSettings,
          secret,
        });
        setModelLists((prev) => ({ ...prev, [provider]: models }));
      } catch (e) {
        setRefreshError((prev) => ({
          ...prev,
          [provider]: appErrorMessage(e),
        }));
      } finally {
        setRefreshing(null);
      }
    },
    [draft, secretEdits]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <button
        type="button"
        aria-label="关闭设置"
        className="absolute inset-0 bg-foreground/25"
        onClick={onClose}
      />

      <div className="relative flex h-[600px] w-full max-w-4xl flex-col overflow-hidden rounded-[10px] border border-border bg-surface shadow-[0_20px_60px_-24px_rgba(0,0,0,0.22)]">
        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
          <h2
            id="settings-title"
            className="text-[17px] font-medium text-foreground"
          >
            设置
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="grid h-7 w-7 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <TabRail
            tab={tab}
            setTab={setTab}
            draft={draft}
            secretPresent={secretPresent}
            secretEdits={secretEdits}
          />

          <section className="flex-1 overflow-y-auto">
            {tab === "prompt" ? (
              <PromptPanel
                value={draft.ocr_prompt}
                onChange={(v) =>
                  setDraft((d) => ({ ...d, ocr_prompt: v }))
                }
              />
            ) : (
              <ProviderPanel
                provider={tab}
                draft={draft}
                setDraft={setDraft}
                models={modelLists[tab] ?? []}
                refreshing={refreshing === tab}
                refreshError={refreshError[tab]}
                onRefresh={() => refreshModels(tab)}
                secretPresent={secretPresent[PROVIDER_SECRET_KEY[tab]]}
                secretEdit={secretEdits[PROVIDER_SECRET_KEY[tab]]}
                revealed={!!revealedSecrets[PROVIDER_SECRET_KEY[tab]]}
                onSecretEdit={(value) =>
                  setSecretEdits((prev) => ({
                    ...prev,
                    [PROVIDER_SECRET_KEY[tab]]: value,
                  }))
                }
                onToggleReveal={() =>
                  setRevealedSecrets((prev) => ({
                    ...prev,
                    [PROVIDER_SECRET_KEY[tab]]: !prev[PROVIDER_SECRET_KEY[tab]],
                  }))
                }
                onDeleteSecret={() =>
                  setSecretEdits((prev) => ({
                    ...prev,
                    [PROVIDER_SECRET_KEY[tab]]: null,
                  }))
                }
              />
            )}
          </section>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-border bg-surface-2 pl-6 pr-7 py-3">
          <div className="flex min-w-0 items-center gap-3 text-[11px] text-foreground-muted">
            {saveError ? (
              <span className="text-destructive">保存失败：{saveError}</span>
            ) : (
              <>
                <span className="truncate">
                  Keychain 存 API Key · 其余写入{" "}
                  <span className="font-mono text-foreground-subtle">
                    {"${AppConfig}/settings.json"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void ipcOpenLogDir().catch((e) => {
                      const message = appErrorMessage(e);
                      void logWarn(`open_log_dir failed: ${message}`).catch(
                        () => {}
                      );
                    });
                  }}
                  title="在文件管理器中打开日志目录"
                  className="flex shrink-0 items-center gap-1 rounded text-foreground-subtle transition-colors hover:text-foreground"
                >
                  <FolderOpen className="h-3 w-3" strokeWidth={1.75} />
                  <span>日志</span>
                </button>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => void trySave()}
            disabled={saving}
            className="flex h-[34px] items-center rounded border border-transparent bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface TabRailProps {
  tab: TabId;
  setTab: (t: TabId) => void;
  draft: NonSecretSettings;
  secretPresent: Record<SecretKey, boolean>;
  secretEdits: Partial<Record<SecretKey, string | null>>;
}

function TabRail({
  tab,
  setTab,
  draft,
  secretPresent,
  secretEdits,
}: TabRailProps) {
  return (
    <nav className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-border bg-surface-2/50 p-3">
      <div className="mb-1 px-3 pt-1 text-[11px] font-medium uppercase tracking-wider text-foreground-subtle">
        OCR 服务商
      </div>
      {PROVIDER_ORDER.map((p) => {
        const key = PROVIDER_SECRET_KEY[p];
        const present = effectiveSecretPresent(key, secretPresent, secretEdits);
        const isActive = draft.provider === p;
        return (
          <TabButton
            key={p}
            active={tab === p}
            label={PROVIDER_LABEL[p]}
            onClick={() => setTab(p)}
            badge={isActive ? "当前" : undefined}
            dot={present ? "configured" : "empty"}
          />
        );
      })}
      <div className="my-2 h-px bg-border" />
      <div className="mb-1 px-3 pt-1 text-[11px] font-medium uppercase tracking-wider text-foreground-subtle">
        通用
      </div>
      <TabButton
        active={tab === "prompt"}
        label="识别提示词"
        onClick={() => setTab("prompt")}
      />
    </nav>
  );
}

function effectiveSecretPresent(
  key: SecretKey,
  present: Record<SecretKey, boolean>,
  edits: Partial<Record<SecretKey, string | null>>
): boolean {
  if (key in edits) {
    const v = edits[key];
    if (v === null) return false;
    if (typeof v === "string" && v.length > 0) return true;
  }
  return present[key];
}

interface TabButtonProps {
  active: boolean;
  label: string;
  onClick: () => void;
  badge?: string;
  dot?: "configured" | "empty";
}

function TabButton({ active, label, onClick, badge, dot }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] transition-colors ${
        active
          ? "bg-surface-2 font-medium text-foreground"
          : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
      }`}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-primary"
        />
      )}
      {dot && (
        <span
          aria-hidden
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
            dot === "configured" ? "bg-success" : "bg-foreground-subtle/60"
          }`}
        />
      )}
      <span className="flex-1 truncate">{label}</span>
      {badge && (
        <span className="rounded bg-primary-muted px-1.5 py-px text-[10px] font-medium text-primary">
          {badge}
        </span>
      )}
    </button>
  );
}

interface ProviderPanelProps {
  provider: Provider;
  draft: NonSecretSettings;
  setDraft: React.Dispatch<React.SetStateAction<NonSecretSettings>>;
  models: string[];
  refreshing: boolean;
  refreshError?: string;
  onRefresh: () => void;
  secretPresent: boolean;
  secretEdit: string | null | undefined;
  revealed: boolean;
  onSecretEdit: (value: string | null) => void;
  onToggleReveal: () => void;
  onDeleteSecret: () => void;
}

function ProviderPanel({
  provider,
  draft,
  setDraft,
  models,
  refreshing,
  refreshError,
  onRefresh,
  secretPresent,
  secretEdit,
  revealed,
  onSecretEdit,
  onToggleReveal,
  onDeleteSecret,
}: ProviderPanelProps) {
  const isActive = draft.provider === provider;

  const modelValue = useMemo(() => {
    switch (provider) {
      case "paddleocr":
        return draft.paddle_model;
      case "openai":
        return draft.openai_model;
      case "openrouter":
        return draft.openrouter_model;
      case "openai_compatible":
        return draft.openai_compatible_model;
    }
  }, [provider, draft]);

  const setModelValue = (v: string) =>
    setDraft((d) => {
      const next = { ...d };
      switch (provider) {
        case "paddleocr":
          next.paddle_model = v;
          break;
        case "openai":
          next.openai_model = v;
          break;
        case "openrouter":
          next.openrouter_model = v;
          break;
        case "openai_compatible":
          next.openai_compatible_model = v;
          break;
      }
      return next;
    });

  // Show the typed-in draft when present, otherwise mask. Backend never
  // returns the actual key, so we cannot "show" a previously-saved one.
  const secretInputValue = useMemo(() => {
    if (secretEdit === null) return "";
    if (typeof secretEdit === "string") return secretEdit;
    return "";
  }, [secretEdit]);
  const secretPlaceholder = secretPresent && secretEdit === undefined
    ? "已配置（输入新值覆盖；不回显已存的密钥）"
    : "粘贴或输入 API Key";

  return (
    <div className="px-7 py-6">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-[15px] font-medium text-foreground">
          {PROVIDER_LABEL[provider]}
        </h3>
        {effectiveSecretPresent_local() && (
          <span className="rounded bg-primary-muted px-1.5 py-0.5 text-[11px] font-medium text-primary">
            已配置
          </span>
        )}
        {!isActive && (
          <button
            type="button"
            onClick={() =>
              setDraft((d) => ({ ...d, provider }))
            }
            className="ml-auto text-[11px] text-primary hover:underline"
          >
            设为当前服务商
          </button>
        )}
        {isActive && (
          <span className="ml-auto rounded border border-success/40 px-1.5 py-0.5 text-[11px] font-medium text-success">
            当前
          </span>
        )}
      </div>
      <p className="mb-5 text-[13px] text-foreground-muted">
        {PROVIDER_NOTE[provider]}
      </p>

      <div className="space-y-4">
        {provider === "paddleocr" && (
          <Field label="Endpoint">
            <input
              type="text"
              value={draft.paddle_url}
              onChange={(e) =>
                setDraft((d) => ({ ...d, paddle_url: e.target.value }))
              }
              placeholder={DEFAULT_SETTINGS.paddle_url}
              className="h-8 w-full rounded border border-border bg-background px-2.5 font-mono text-[12px] text-foreground placeholder:text-foreground-subtle/70 focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
            />
          </Field>
        )}

        {provider === "openai_compatible" && (
          <Field label="Base URL" hint="例：https://api.deepseek.com/v1">
            <input
              type="text"
              value={draft.openai_compatible_base_url}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  openai_compatible_base_url: e.target.value,
                }))
              }
              placeholder="https://…/v1"
              className="h-8 w-full rounded border border-border bg-background px-2.5 font-mono text-[12px] text-foreground placeholder:text-foreground-subtle/70 focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
            />
          </Field>
        )}

        <Field label={provider === "paddleocr" ? "Token" : "API Key"}>
          <div className="flex gap-1.5">
            <input
              type={revealed ? "text" : "password"}
              value={secretInputValue}
              onChange={(e) => onSecretEdit(e.target.value)}
              placeholder={secretPlaceholder}
              className="h-8 flex-1 rounded border border-border bg-background px-2.5 font-mono text-[12px] text-foreground placeholder:text-foreground-subtle/70 focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
            />
            <button
              type="button"
              onClick={onToggleReveal}
              className="flex h-8 items-center rounded border border-border bg-transparent px-3 text-[11px] text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              {revealed ? "隐藏" : "显示"}
            </button>
            <button
              type="button"
              onClick={onDeleteSecret}
              className="flex h-8 items-center rounded border border-destructive/40 bg-transparent px-3 text-[11px] text-destructive transition-colors hover:bg-destructive/10"
            >
              删除
            </button>
          </div>
          <div className="text-[11px] text-foreground-subtle">
            {secretEdit === null
              ? "保存后将从 Keychain 移除"
              : typeof secretEdit === "string" && secretEdit.length > 0
                ? "保存后写入 Keychain"
                : secretPresent
                  ? "✓ Keychain 已存有 Key"
                  : "未配置"}
          </div>
        </Field>

        <Field label="模型">
          <div className="flex items-center justify-between">
            <select
              value={modelValue}
              onChange={(e) => setModelValue(e.target.value)}
              className="h-8 flex-1 rounded border border-border bg-background px-2 text-[13px] text-foreground focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
            >
              {modelOptions(provider, modelValue, models).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              className="ml-2 flex items-center gap-1 rounded border border-border bg-transparent px-2.5 py-1 text-[11px] text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              title="刷新模型列表"
            >
              <RefreshCw
                className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
                strokeWidth={1.8}
              />
              刷新
            </button>
          </div>
          {refreshError && (
            <div className="text-[11px] text-destructive">
              刷新失败：{refreshError}
            </div>
          )}
          {provider === "paddleocr" && (
            <div className="text-[11px] text-foreground-subtle">
              异步 jobs API 没有模型列表端点，仅暴露 VL 系列。
            </div>
          )}
        </Field>
      </div>
    </div>
  );

  // Lift a tiny closure to reuse the secret-presence calc for the badge.
  function effectiveSecretPresent_local() {
    if (secretEdit === null) return false;
    if (typeof secretEdit === "string" && secretEdit.length > 0) return true;
    return secretPresent;
  }
}

/** Build the dropdown options. We always include the current value (even if
 *  not in the refreshed list) so the user doesn't lose their saved selection
 *  just because a provider's `/models` response shifted. */
function modelOptions(
  provider: Provider,
  current: string,
  refreshed: string[]
): string[] {
  const seeds: string[] = [];
  if (current) seeds.push(current);
  switch (provider) {
    case "paddleocr":
      seeds.push("PaddleOCR-VL", "PaddleOCR-VL-1.5");
      break;
    case "openai":
      seeds.push("gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini");
      break;
    case "openrouter":
      seeds.push(
        "google/gemini-2.5-flash-preview",
        "anthropic/claude-sonnet-4-6",
        "openai/gpt-4o"
      );
      break;
    case "openai_compatible":
      // No defaults — user must refresh against their endpoint.
      break;
  }
  const merged = [...seeds, ...refreshed];
  return Array.from(new Set(merged.filter(Boolean)));
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-[13px] font-medium text-foreground">
          {label}
        </label>
        {hint && (
          <span className="text-[11px] text-foreground-subtle">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

interface PromptPanelProps {
  value: string;
  onChange: (next: string) => void;
}

function PromptPanel({ value, onChange }: PromptPanelProps) {
  return (
    <div className="px-7 py-6">
      <h3 className="mb-1 text-[15px] font-medium text-foreground">
        识别提示词
      </h3>
      <p className="mb-5 text-[13px] text-foreground-muted">
        OpenAI / OpenRouter / 兼容端点会随每次请求把这段提示词发给视觉模型。PaddleOCR 不接受自定义提示词。
      </p>
      <Field label="自定义识别提示词">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={DEFAULT_SETTINGS.ocr_prompt}
          className="min-h-[140px] rounded border border-border bg-background p-2.5 text-[13px] leading-relaxed text-foreground placeholder:text-foreground-subtle/70 focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
        />
        <div className="flex items-center justify-between text-[11px] text-foreground-subtle">
          <span>留空时使用默认提示词。</span>
          <button
            type="button"
            onClick={() => onChange(DEFAULT_SETTINGS.ocr_prompt)}
            className="text-foreground-muted transition-colors hover:text-foreground"
          >
            恢复默认
          </button>
        </div>
      </Field>
    </div>
  );
}
