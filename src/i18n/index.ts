import { useSyncExternalStore } from "react";
import { en, zh, type MessageKey } from "./messages";

export type Language = "zh" | "en";

export const LANGUAGES: Language[] = ["zh", "en"];

const CATALOGS: Record<Language, Record<MessageKey, string>> = { zh, en };

/** Mirrors the language into `localStorage` so the very first paint after a
 *  restart already uses the right catalog — settings hydration is async and
 *  would otherwise flash Chinese at an English user. */
const STORAGE_KEY = "xcvt.language";

export function isLanguage(value: unknown): value is Language {
  return value === "zh" || value === "en";
}

function detectInitialLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {
    // Private mode / no DOM (tests): fall through to the navigator probe.
  }
  try {
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "zh";
  }
}

let current: Language = detectInitialLanguage();
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return current;
}

/** Switches the active catalog and re-renders every `useT()` consumer.
 *  Non-React callers (store slices, plain modules) just read `t()` lazily,
 *  so they pick the new language up on their next call. */
export function setLanguage(next: Language): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Persisting the hint is best-effort; settings.json remains the source
    // of truth.
  }
  if (next === current) return;
  current = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type MessageParams = Record<string, string | number>;

export function t(key: MessageKey, params?: MessageParams): string {
  const template = CATALOGS[current][key] ?? zh[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export type Translator = typeof t;

/** Subscribes a component to language changes. `t` itself is language-free —
 *  it reads the active catalog on each call — so the hook only needs to force
 *  a re-render when the language flips. */
export function useT(): typeof t {
  useSyncExternalStore(subscribe, getLanguage, getLanguage);
  return t;
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

export type { MessageKey };
