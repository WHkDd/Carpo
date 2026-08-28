import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { useStore } from "@/store";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { DEFAULT_SETTINGS, defaultOcrPrompt, defaultProofreadPrompt } from "@/store/settingsSlice";
import {
  getLanguage,
  LANGUAGES,
  setLanguage as applyLanguage,
  useT,
  type Language,
  type Translator,
} from "@/i18n";
import {
  deleteSecret as ipcDeleteSecret,
  getSecret as ipcGetSecret,
  listProviderModels as ipcListProviderModels,
  setSecret as ipcSetSecret,
  setSettings as ipcSetSettings,
} from "@/lib/tauri";
import {
  getThemePreference,
  setThemePreference,
  THEME_PREFERENCES,
} from "@/lib/theme";
import type {
  NonSecretSettings,
  PaddleDocumentOptions,
  Provider,
  SecretKey,
  Theme,
} from "@/lib/ipc-types";
import { appErrorMessage } from "@/lib/ipc-types";

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

type TabId = Provider | "prompt" | "proofread" | "appearance" | "language";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const t = useT();
  const committed = useStore((s) => s.settings);
  const setCommitted = useStore((s) => s.setSettings);
  // This dialog is the only place that reads the Keychain outside an actual
  // OCR run, so it is also the only place that can tell the rest of the UI
  // which credentials exist. See `credentialPresence` in the settings slice.
  const mergeCredentialPresence = useStore((s) => s.mergeCredentialPresence);
  const bumpCredentialRevision = useStore((s) => s.bumpCredentialRevision);

  const [draft, setDraft] = useState<NonSecretSettings>(committed);
  const [tab, setTab] = useState<TabId>(committed.provider);
  const [secretPresent, setSecretPresent] = useState<Record<SecretKey, boolean>>({
    paddle_token: false,
    openai_key: false,
    openrouter_key: false,
    openai_compatible_key: false,
  });
  /** Keyed by SecretKey: blank means "no edit"; non-blank means user typed a
   *  new value and we'll send it on save. `null` means user clicked Delete — we
   *  fire delete_secret on save. */
  const [secretEdits, setSecretEdits] = useState<
    Partial<Record<SecretKey, string | null>>
  >({});
  const [revealedSecrets, setRevealedSecrets] = useState<
    Partial<Record<SecretKey, boolean>>
  >({});
  const [modelLists, setModelLists] = useState<Partial<Record<Provider, string[]>>>({
    paddleocr: ["PaddleOCR-VL-1.6", "PaddleOCR-VL"],
  });
  const [refreshing, setRefreshing] = useState<Provider | null>(null);
  const [refreshError, setRefreshError] = useState<Partial<Record<Provider, string>>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Language active when the dialog opened, so cancelling can restore it
  // even when nothing was ever committed (`committed.language === null`).
  const languageOnOpenRef = useRef<Language>(getLanguage());
  // Same snapshot for the theme: the AppearancePanel previews instantly, so
  // walking away has to put the dialog-open theme back.
  const themeOnOpenRef = useRef<Theme>(getThemePreference());
  const committedRef = useRef(committed);
  const wasOpenRef = useRef(false);
  committedRef.current = committed;

  // Focus enters the dialog on open, is trapped while it is up, and returns
  // to the control that opened it on close.
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(open, dialogRef);

  // Reset draft + tab + presence whenever the dialog opens.
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    // Hydration can update `committed` while the dialog is already open. Do
    // not replace the user's draft or cancellation snapshot in that case.
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    languageOnOpenRef.current = getLanguage();
    themeOnOpenRef.current = getThemePreference();
    setDraft(committedRef.current);
    setTab(committedRef.current.provider);
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
      const presence = Object.fromEntries(entries) as Record<SecretKey, boolean>;
      setSecretPresent(presence);
      mergeCredentialPresence(presence);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mergeCredentialPresence]);

  // The language select previews immediately (the whole app re-renders), so
  // walking away from the dialog has to put the committed language back. The
  // theme preview gets the same treatment.
  const closeAndRevertLanguage = useCallback(() => {
    applyLanguage(languageOnOpenRef.current);
    setThemePreference(themeOnOpenRef.current);
    onClose();
  }, [onClose]);

  // Esc to close, ⌘S to save.
  const trySave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // Persist all secret edits first so even if non-secret save fails the
      // Keychain reflects the user's intent.
      const written: Partial<Record<SecretKey, boolean>> = {};
      for (const [key, value] of Object.entries(secretEdits) as Array<
        [SecretKey, string | null]
      >) {
        if (value === null) {
          await ipcDeleteSecret(key);
          written[key] = false;
        } else if (value.length > 0) {
          await ipcSetSecret(key, value);
          written[key] = true;
        }
      }
      await ipcSetSettings(draft);
      setCommitted(draft);
      // Presence is now known for every key we just touched — publish it so
      // the status bar updates without anyone re-reading the Keychain.
      mergeCredentialPresence(written);
      // Any cache keyed on credentials (the proofread model list) must see
      // this write — presence alone is a boolean and misses "key A replaced
      // with key B".
      if (Object.keys(written).length > 0) {
        bumpCredentialRevision();
      }
      onClose();
    } catch (e) {
      setSaveError(appErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [draft, secretEdits, setCommitted, mergeCredentialPresence, bumpCredentialRevision, onClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeAndRevertLanguage();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void trySave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, closeAndRevertLanguage, trySave]);

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

  // The proofread pass runs on its own provider when set, otherwise on the
  // OCR provider. Its model dropdown shares the per-provider model-list
  // cache with the provider tabs.
  const proofreadProvider = draft.proofread_provider ?? draft.provider;

  if (!open) return null;

  return (
    // `app-chrome` because this renders as a sibling of the shell's <main>,
    // not inside it: without the class the chrome rules in globals.css stop
    // at the dialog's edge, and every label in the app's most text-dense
    // surface becomes drag-selectable — the plainest "this is a web page"
    // tell there is. It also restores the fallback focus ring.
    <div className="app-chrome fixed inset-0 z-50 flex items-center justify-center">
      {/* Scrim. Not focusable: a dialog's dismissal target should not be a
          tab stop competing with the controls inside it — Escape and the
          close button are the keyboard paths. Black rather than
          foreground-derived: on dark backgrounds `foreground/25` becomes a
          brightening wash, and a scrim must always dim. */}
      <div
        role="presentation"
        className="absolute inset-0 bg-black/35 dark:bg-black/55"
        onClick={closeAndRevertLanguage}
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="relative flex h-[600px] w-full max-w-4xl flex-col overflow-hidden rounded-[10px] border border-border bg-surface shadow-[0_20px_60px_-24px_rgba(0,0,0,0.22)]"
      >
        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
          <h2
            id="settings-title"
            className="text-[17px] font-medium text-foreground"
          >
            {t("settings.title")}
          </h2>
          <button
            type="button"
            onClick={closeAndRevertLanguage}
            aria-label={t("common.close")}
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

          <section
            role="tabpanel"
            id={settingsTabPanelId(tab)}
            aria-labelledby={`settings-tab-${tab}`}
            tabIndex={-1}
            className="flex-1 overflow-y-auto overscroll-contain"
          >
            {tab === "language" ? (
              <LanguagePanel
                value={draft.language ?? languageOnOpenRef.current}
                onChange={(language) => {
                  setDraft((d) => ({ ...d, language }));
                  applyLanguage(language);
                }}
              />
            ) : tab === "appearance" ? (
              <AppearancePanel
                value={draft.theme ?? themeOnOpenRef.current}
                onChange={(theme) => {
                  setDraft((d) => ({ ...d, theme }));
                  // Preview immediately, mirroring the language panel: the
                  // document updates at once, and closing without saving
                  // restores the theme that was active when the dialog
                  // opened.
                  setThemePreference(theme);
                }}
              />
            ) : tab === "prompt" ? (
              <PromptPanel
                value={draft.ocr_prompt}
                onChange={(v) =>
                  setDraft((d) => ({ ...d, ocr_prompt: v }))
                }
              />
            ) : tab === "proofread" ? (
              <ProofreadPanel
                draft={draft}
                setDraft={setDraft}
                effectiveProvider={proofreadProvider}
                models={modelLists[proofreadProvider] ?? []}
                refreshing={refreshing === proofreadProvider}
                refreshError={refreshError[proofreadProvider]}
                onRefresh={() => refreshModels(proofreadProvider)}
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

        <footer className="flex items-center justify-end gap-4 border-t border-border bg-surface-2 pl-6 pr-7 py-3">
          {saveError && (
            <span className="min-w-0 flex-1 truncate text-[11px] text-destructive">
              {t("settings.saveFailed", { message: saveError })}
            </span>
          )}
          <button
            type="button"
            onClick={() => void trySave()}
            disabled={saving}
            className="flex h-[34px] items-center rounded border border-transparent bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 active:bg-primary/80 disabled:cursor-default disabled:opacity-60"
          >
            {saving ? t("common.saving") : t("common.save")}
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

/** Tab order of the rail, used by the arrow-key handler. Must match the
 *  render order below. */
const TAB_ORDER: TabId[] = [
  ...PROVIDER_ORDER,
  "prompt",
  "proofread",
  "appearance",
  "language",
];

export function settingsTabPanelId(tab: TabId): string {
  return `settings-panel-${tab}`;
}

function tabButtonId(tab: TabId): string {
  return `settings-tab-${tab}`;
}

function TabRail({
  tab,
  setTab,
  draft,
  secretPresent,
  secretEdits,
}: TabRailProps) {
  const t = useT();
  const railRef = useRef<HTMLDivElement>(null);

  // A tablist is one tab stop; ↑/↓ move between tabs and switch the panel.
  // Previously every tab was its own tab stop, so reaching the Save button
  // meant tabbing past all six.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const index = TAB_ORDER.indexOf(tab);
    let next: TabId | null = null;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      next = TAB_ORDER[(index + 1) % TAB_ORDER.length]!;
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      next = TAB_ORDER[(index - 1 + TAB_ORDER.length) % TAB_ORDER.length]!;
    } else if (e.key === "Home") {
      next = TAB_ORDER[0]!;
    } else if (e.key === "End") {
      next = TAB_ORDER[TAB_ORDER.length - 1]!;
    }
    if (!next) return;
    e.preventDefault();
    setTab(next);
    railRef.current
      ?.querySelector<HTMLElement>(`#${tabButtonId(next)}`)
      ?.focus();
  };

  return (
    <div
      ref={railRef}
      role="tablist"
      aria-orientation="vertical"
      aria-label={t("settings.title")}
      onKeyDown={onKeyDown}
      className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-border bg-surface-2/50 p-3"
    >
      <div className="mb-1 px-3 pt-1 text-[11px] font-medium tracking-wider text-foreground-subtle">
        {t("settings.providerSection")}
      </div>
      {PROVIDER_ORDER.map((p) => {
        const key = PROVIDER_SECRET_KEY[p];
        const present = effectiveSecretPresent(key, secretPresent, secretEdits);
        const isActive = draft.provider === p;
        return (
          <TabButton
            key={p}
            id={p}
            active={tab === p}
            label={providerLabel(p, t)}
            onClick={() => setTab(p)}
            badge={isActive ? t("settings.current") : undefined}
            dot={present ? "configured" : "empty"}
          />
        );
      })}
      <div className="my-2 h-px bg-border" />
      <div className="mb-1 px-3 pt-1 text-[11px] font-medium tracking-wider text-foreground-subtle">
        {t("settings.generalSection")}
      </div>
      <TabButton
        id="prompt"
        active={tab === "prompt"}
        label={t("settings.promptTab")}
        onClick={() => setTab("prompt")}
      />
      <TabButton
        id="proofread"
        active={tab === "proofread"}
        label={t("settings.proofreadTab")}
        onClick={() => setTab("proofread")}
      />
      <TabButton
        id="appearance"
        active={tab === "appearance"}
        label={t("settings.appearanceTab")}
        onClick={() => setTab("appearance")}
      />
      <TabButton
        id="language"
        active={tab === "language"}
        label={t("settings.languageTab")}
        onClick={() => setTab("language")}
      />
    </div>
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
  id: TabId;
  active: boolean;
  label: string;
  onClick: () => void;
  badge?: string;
  dot?: "configured" | "empty";
}

function TabButton({ id, active, label, onClick, badge, dot }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      id={tabButtonId(id)}
      aria-selected={active}
      aria-controls={settingsTabPanelId(id)}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={`relative flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${
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
            dot === "configured" ? "bg-success" : "bg-foreground-subtle/80"
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
  const t = useT();
  const isActive = draft.provider === provider;
  const paddleOptions = draft.paddle_document_options ??
    DEFAULT_SETTINGS.paddle_document_options;

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

  const setPaddleDocumentOption = <K extends keyof PaddleDocumentOptions>(
    key: K,
    value: PaddleDocumentOptions[K]
  ) =>
    setDraft((d) => ({
      ...d,
      paddle_document_options: {
        ...DEFAULT_SETTINGS.paddle_document_options,
        ...d.paddle_document_options,
        [key]: value,
      },
    }));

  // Show the typed-in draft when present, otherwise mask. Backend never
  // returns the actual key, so we cannot "show" a previously-saved one.
  const secretInputValue = useMemo(() => {
    if (secretEdit === null) return "";
    if (typeof secretEdit === "string") return secretEdit;
    return "";
  }, [secretEdit]);
  const secretPlaceholder = secretPresent && secretEdit === undefined
    ? t("settings.secretPlaceholderConfigured")
    : t("settings.secretPlaceholder");

  return (
    <div className="px-7 py-6">
      <div className="mb-5 flex items-center gap-2">
        <h3 className="text-[15px] font-medium text-foreground">
          {providerLabel(provider, t)}
        </h3>
        {effectiveSecretPresent_local() && (
          <span className="rounded bg-primary-muted px-1.5 py-0.5 text-[11px] font-medium text-primary">
            {t("settings.configured")}
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
            {t("settings.setActiveProvider")}
          </button>
        )}
        {isActive && (
          <span className="ml-auto rounded border border-success/40 px-1.5 py-0.5 text-[11px] font-medium text-success">
            {t("settings.current")}
          </span>
        )}
      </div>

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
              className="h-8 w-full rounded border border-border bg-background px-2.5 font-mono text-[12px] text-foreground placeholder:text-foreground-placeholder focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
            />
          </Field>
        )}

        {provider === "openai_compatible" && (
          <Field label="Base URL">
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
              className="h-8 w-full rounded border border-border bg-background px-2.5 font-mono text-[12px] text-foreground placeholder:text-foreground-placeholder focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
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
              className="h-8 flex-1 rounded border border-border bg-background px-2.5 font-mono text-[12px] text-foreground placeholder:text-foreground-placeholder focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
            />
            <button
              type="button"
              onClick={onToggleReveal}
              className="flex h-8 items-center rounded border border-border bg-transparent px-3 text-[11px] text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              {revealed ? t("common.hide") : t("common.show")}
            </button>
            <button
              type="button"
              onClick={onDeleteSecret}
              className="flex h-8 items-center rounded border border-destructive/40 bg-transparent px-3 text-[11px] text-destructive transition-colors hover:bg-destructive/10"
            >
              {t("common.delete")}
            </button>
          </div>
          <div className="text-[11px] text-foreground-subtle">
            {secretEdit === null
              ? t("settings.secretRemoveOnSave")
              : typeof secretEdit === "string" && secretEdit.length > 0
                ? t("settings.secretUpdateOnSave")
                : secretPresent
                  ? t("settings.secretSaved")
                  : t("settings.secretMissing")}
          </div>
        </Field>

        <Field label={t("settings.model")}>
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
              className="ml-2 flex items-center gap-1 rounded border border-border bg-transparent px-2.5 py-1 text-[11px] text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground active:bg-surface-overlay disabled:cursor-default disabled:opacity-60"
              title={t("settings.refreshModels")}
            >
              <RefreshCw
                className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
                strokeWidth={1.8}
              />
              {t("common.refresh")}
            </button>
          </div>
          {refreshError && (
            <div className="text-[11px] text-destructive">
              {t("settings.refreshFailed", { message: refreshError })}
            </div>
          )}
          {provider === "paddleocr" && (
            <div className="text-[11px] text-foreground-subtle">
              {t("settings.paddleModelNote")}
            </div>
          )}
        </Field>

        {provider === "paddleocr" && (
          <PaddleDocumentOptionsPanel
            options={paddleOptions}
            onChange={setPaddleDocumentOption}
          />
        )}
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

interface PaddleDocumentOptionsPanelProps {
  options: PaddleDocumentOptions;
  onChange: <K extends keyof PaddleDocumentOptions>(
    key: K,
    value: PaddleDocumentOptions[K]
  ) => void;
}

function PaddleDocumentOptionsPanel({
  options,
  onChange,
}: PaddleDocumentOptionsPanelProps) {
  const t = useT();
  return (
    <div className="border-t border-border pt-4">
      <div className="mb-3">
        <h4 className="text-[13px] font-medium text-foreground">
          {t("settings.paddleDocTitle")}
        </h4>
        <p className="mt-1 text-[11px] text-foreground-subtle">
          {t("settings.paddleDocNote")}
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <div className="mb-2 text-[12px] font-medium text-foreground-muted">
            {t("settings.paddleDocAuxGroup")}
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <ToggleRow
              label={t("settings.opt.header")}
              checked={options.includeHeader}
              onChange={(v) => onChange("includeHeader", v)}
            />
            <ToggleRow
              label={t("settings.opt.headerImage")}
              checked={options.includeHeaderImage}
              onChange={(v) => onChange("includeHeaderImage", v)}
            />
            <ToggleRow
              label={t("settings.opt.footer")}
              checked={options.includeFooter}
              onChange={(v) => onChange("includeFooter", v)}
            />
            <ToggleRow
              label={t("settings.opt.footerImage")}
              checked={options.includeFooterImage}
              onChange={(v) => onChange("includeFooterImage", v)}
            />
            <ToggleRow
              label={t("settings.opt.pageNumber")}
              checked={options.includePageNumber}
              onChange={(v) => onChange("includePageNumber", v)}
            />
            <ToggleRow
              label={t("settings.opt.footnote")}
              checked={options.includeFootnote}
              onChange={(v) => onChange("includeFootnote", v)}
            />
            <ToggleRow
              label={t("settings.opt.asideText")}
              checked={options.includeAsideText}
              onChange={(v) => onChange("includeAsideText", v)}
            />
          </div>
        </div>

        <div>
          <div className="mb-2 text-[12px] font-medium text-foreground-muted">
            {t("settings.paddleDocModelGroup")}
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <ToggleRow
              label={t("settings.opt.docOrientation")}
              checked={options.useDocOrientationClassify}
              onChange={(v) => onChange("useDocOrientationClassify", v)}
            />
            <ToggleRow
              label={t("settings.opt.docUnwarping")}
              checked={options.useDocUnwarping}
              onChange={(v) => onChange("useDocUnwarping", v)}
            />
            <ToggleRow
              label={t("settings.opt.layoutDetection")}
              checked={options.useLayoutDetection}
              onChange={(v) => onChange("useLayoutDetection", v)}
            />
            <ToggleRow
              label={t("settings.opt.chartRecognition")}
              checked={options.useChartRecognition}
              onChange={(v) => onChange("useChartRecognition", v)}
            />
            <ToggleRow
              label={t("settings.opt.sealRecognition")}
              checked={options.useSealRecognition}
              onChange={(v) => onChange("useSealRecognition", v)}
            />
            <ToggleRow
              label={t("settings.opt.ocrForImageBlock")}
              checked={options.useOcrForImageBlock}
              onChange={(v) => onChange("useOcrForImageBlock", v)}
            />
            <ToggleRow
              label={t("settings.opt.mergeTables")}
              checked={options.mergeTables}
              onChange={(v) => onChange("mergeTables", v)}
            />
            <ToggleRow
              label={t("settings.opt.relevelTitles")}
              checked={options.relevelTitles}
              onChange={(v) => onChange("relevelTitles", v)}
            />
            <ToggleRow
              label={t("settings.opt.restructurePages")}
              checked={options.restructurePages}
              onChange={(v) => onChange("restructurePages", v)}
            />
            <ToggleRow
              label={t("settings.opt.layoutNms")}
              checked={options.layoutNms}
              onChange={(v) => onChange("layoutNms", v)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <SelectSetting
            label={t("settings.layoutShapeMode")}
            value={options.layoutShapeMode}
            options={[
              ["auto", t("settings.layoutShape.auto")],
              ["rectangle", t("settings.layoutShape.rectangle")],
              ["quadrilateral", t("settings.layoutShape.quadrilateral")],
              ["polygon", t("settings.layoutShape.polygon")],
            ]}
            onChange={(v) => onChange("layoutShapeMode", v)}
          />
          <SelectSetting
            label={t("settings.promptLabel")}
            value={options.promptLabel}
            options={[
              ["ocr", t("settings.promptLabel.ocr")],
              ["formula", t("settings.promptLabel.formula")],
              ["table", t("settings.promptLabel.table")],
              ["chart", t("settings.promptLabel.chart")],
              ["seal", t("settings.promptLabel.seal")],
              [
                "text_detection_recognition",
                t("settings.promptLabel.textDetection"),
              ],
            ]}
            onChange={(v) => onChange("promptLabel", v)}
          />
          <NumberSetting
            label={t("settings.repetitionPenalty")}
            value={options.repetitionPenalty}
            step={0.1}
            onChange={(v) => onChange("repetitionPenalty", v)}
          />
          <NumberSetting
            label={t("settings.temperature")}
            value={options.temperature}
            step={0.1}
            onChange={(v) => onChange("temperature", v)}
          />
          <NumberSetting
            label={t("settings.topP")}
            value={options.topP}
            step={0.1}
            onChange={(v) => onChange("topP", v)}
          />
          <NumberSetting
            label={t("settings.minPixels")}
            value={options.minPixels}
            step={1}
            onChange={(v) => onChange("minPixels", Math.max(1, Math.round(v)))}
          />
          <NumberSetting
            label={t("settings.maxPixels")}
            value={options.maxPixels}
            step={1}
            onChange={(v) => onChange("maxPixels", Math.max(1, Math.round(v)))}
          />
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex h-7 items-center justify-between gap-3 text-[12px] text-foreground">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-primary"
      />
    </label>
  );
}

function SelectSetting({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-foreground-muted">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded border border-border bg-background px-2 text-[12px] text-foreground focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberSetting({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-foreground-muted">
        {label}
      </span>
      <input
        type="number"
        value={value}
        step={step}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        className="h-8 rounded border border-border bg-background px-2 font-mono text-[12px] text-foreground focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
      />
    </label>
  );
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
      seeds.push("PaddleOCR-VL-1.6", "PaddleOCR-VL");
      break;
    case "openai":
      seeds.push("gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini");
      break;
    case "openrouter":
      seeds.push(
        "google/gemini-2.5-flash",
        "anthropic/claude-sonnet-4.6",
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
  children: React.ReactNode;
}

function Field({ label, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13px] font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}

interface PromptPanelProps {
  value: string;
  onChange: (next: string) => void;
}

function PromptPanel({ value, onChange }: PromptPanelProps) {
  const t = useT();
  return (
    <div className="px-7 py-6">
      <h3 className="mb-1 text-[15px] font-medium text-foreground">
        {t("settings.promptTitle")}
      </h3>
      <p className="mb-5 text-[13px] text-foreground-muted">
        {t("settings.promptDesc")}
      </p>
      <Field label={t("settings.promptField")}>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={defaultOcrPrompt()}
          className="min-h-[140px] rounded border border-border bg-background p-2.5 text-[13px] leading-relaxed text-foreground placeholder:text-foreground-placeholder focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
        />
        <div className="flex items-center justify-between text-[11px] text-foreground-subtle">
          <span>{t("settings.promptEmptyNote")}</span>
          <button
            type="button"
            onClick={() => onChange(defaultOcrPrompt())}
            className="text-foreground-muted transition-colors hover:text-foreground"
          >
            {t("settings.promptReset")}
          </button>
        </div>
      </Field>
    </div>
  );
}

interface ProofreadPanelProps {
  draft: NonSecretSettings;
  setDraft: React.Dispatch<React.SetStateAction<NonSecretSettings>>;
  /** Provider the proofread pass would actually run on: the dedicated
   *  proofread provider when set, otherwise the OCR provider. */
  effectiveProvider: Provider;
  models: string[];
  refreshing: boolean;
  refreshError?: string;
  onRefresh: () => void;
}

/** The LLM proofread pass reuses the providers' credentials and model
 *  fields; it only adds which provider runs it, which model, and the system
 *  prompt. PaddleOCR is absent from the provider list — it cannot chat. */
function ProofreadPanel({
  draft,
  setDraft,
  effectiveProvider,
  models,
  refreshing,
  refreshError,
  onRefresh,
}: ProofreadPanelProps) {
  const t = useT();
  const provider = draft.proofread_provider ?? null;
  // Empty selection means "follow the OCR model" — surface which model that
  // resolves to, so the default option isn't a mystery.
  const fallbackModel = modelFieldPlaceholder(effectiveProvider, draft);
  // PaddleOCR cannot chat, so its OCR models are not proofread candidates.
  const selectableModels =
    effectiveProvider === "paddleocr"
      ? draft.proofread_model
        ? [draft.proofread_model]
        : []
      : modelOptions(effectiveProvider, draft.proofread_model, models);
  return (
    <div className="px-7 py-6">
      <h3 className="mb-1 text-[15px] font-medium text-foreground">
        {t("settings.proofreadTab")}
      </h3>
      <p className="mb-2 text-[13px] text-foreground-muted">
        {t("settings.proofreadProviderNote")}
      </p>
      {/* Proofreading has no text-only mode, so a model without image input
          fails at send time rather than degrading. This is the only warning
          the user gets before that happens. */}
      <p className="mb-5 text-[13px] text-foreground-muted">
        {t("settings.proofreadImageNote")}
      </p>
      <div className="space-y-4">
        <Field label={t("settings.proofreadProvider")}>
          <select
            value={provider ?? ""}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                proofread_provider:
                  e.target.value === "" ? null : (e.target.value as Provider),
              }))
            }
            className="h-8 w-[240px] rounded border border-border bg-background px-2 text-[13px] text-foreground focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
          >
            <option value="">{t("settings.proofreadProviderFollow")}</option>
            {PROVIDER_ORDER.filter((p) => p !== "paddleocr").map((p) => (
              <option key={p} value={p}>
                {providerLabel(p, t)}
              </option>
            ))}
          </select>
          {draft.proofread_provider === "paddleocr" && (
            <div className="text-[11px] text-destructive">
              {t("settings.proofreadProviderNote")}
            </div>
          )}
        </Field>

        <Field label={t("settings.proofreadModel")}>
          <div className="flex items-center justify-between">
            <select
              value={draft.proofread_model}
              onChange={(e) =>
                setDraft((d) => ({ ...d, proofread_model: e.target.value }))
              }
              className="h-8 flex-1 rounded border border-border bg-background px-2 text-[13px] text-foreground focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
            >
              <option value="">
                {fallbackModel
                  ? t("settings.proofreadModelFollow", { model: fallbackModel })
                  : t("settings.proofreadModelFollowEmpty")}
              </option>
              {selectableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing || effectiveProvider === "paddleocr"}
              className="ml-2 flex items-center gap-1 rounded border border-border bg-transparent px-2.5 py-1 text-[11px] text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground active:bg-surface-overlay disabled:cursor-default disabled:opacity-60"
              title={t("settings.refreshModels")}
            >
              <RefreshCw
                className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
                strokeWidth={1.8}
              />
              {t("common.refresh")}
            </button>
          </div>
          {refreshError && (
            <div className="text-[11px] text-destructive">
              {t("settings.refreshFailed", { message: refreshError })}
            </div>
          )}
        </Field>

        <Field label={t("settings.proofreadPromptTitle")}>
          <textarea
            value={draft.proofread_prompt}
            onChange={(e) =>
              setDraft((d) => ({ ...d, proofread_prompt: e.target.value }))
            }
            placeholder={defaultProofreadPrompt()}
            className="min-h-[160px] rounded border border-border bg-background p-2.5 text-[13px] leading-relaxed text-foreground placeholder:text-foreground-placeholder focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
          />
          <div className="flex items-center justify-between text-[11px] text-foreground-subtle">
            <span>{t("settings.promptEmptyNote")}</span>
            <button
              type="button"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  proofread_prompt: defaultProofreadPrompt(),
                }))
              }
              className="text-foreground-muted transition-colors hover:text-foreground"
            >
              {t("settings.promptReset")}
            </button>
          </div>
        </Field>
      </div>
    </div>
  );
}

/** The placeholder shows the OCR-model fallback the backend would actually
 *  use when the proofread model is left empty. */
function modelFieldPlaceholder(
  provider: Provider,
  draft: NonSecretSettings
): string {
  switch (provider) {
    case "openai":
      return draft.openai_model;
    case "openrouter":
      return draft.openrouter_model;
    case "openai_compatible":
      return draft.openai_compatible_model;
    case "paddleocr":
      return "";
  }
}

interface LanguagePanelProps {
  value: Language;
  onChange: (next: Language) => void;
}

function LanguagePanel({ value, onChange }: LanguagePanelProps) {
  const t = useT();
  return (
    <div className="px-7 py-6">
      <h3 className="mb-1 text-[15px] font-medium text-foreground">
        {t("settings.languageTitle")}
      </h3>
      <p className="mb-5 text-[13px] text-foreground-muted">
        {t("settings.languageDesc")}
      </p>
      <Field label={t("settings.languageField")}>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as Language)}
          // `Field` renders its label as a sibling rather than a wrapper, so
          // the control needs its own accessible name.
          aria-label={t("settings.languageField")}
          className="h-8 w-[240px] rounded border border-border bg-background px-2 text-[13px] text-foreground focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
        >
          {LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {t(language === "zh" ? "language.zh" : "language.en")}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-foreground-subtle">
          {t("settings.languageNote")}
        </span>
      </Field>
    </div>
  );
}

interface AppearancePanelProps {
  value: Theme;
  onChange: (next: Theme) => void;
}

const THEME_LABEL_KEY: Record<Theme, "theme.system" | "theme.light" | "theme.dark"> = {
  system: "theme.system",
  light: "theme.light",
  dark: "theme.dark",
};

function AppearancePanel({ value, onChange }: AppearancePanelProps) {
  const t = useT();
  return (
    <div className="px-7 py-6">
      <h3 className="mb-1 text-[15px] font-medium text-foreground">
        {t("settings.appearanceTitle")}
      </h3>
      <p className="mb-5 text-[13px] text-foreground-muted">
        {t("settings.appearanceDesc")}
      </p>
      <Field label={t("settings.appearanceField")}>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as Theme)}
          aria-label={t("settings.appearanceField")}
          className="h-8 w-[240px] rounded border border-border bg-background px-2 text-[13px] text-foreground focus:border-transparent focus:outline focus:outline-2 focus:outline-primary"
        >
          {THEME_PREFERENCES.map((theme) => (
            <option key={theme} value={theme}>
              {t(THEME_LABEL_KEY[theme])}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-foreground-subtle">
          {t("settings.appearanceNote")}
        </span>
      </Field>
    </div>
  );
}
