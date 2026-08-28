/**
 * Theme preference: the single place that owns `documentElement.classList`
 * ("dark"), `style.colorScheme`, the `matchMedia` system listener, and the
 * `localStorage` mirror that lets `applyStartupAppearance()` theme the first
 * frame synchronously (settings hydration is async and arrives too late).
 *
 * Mirrors the `src/i18n` module pattern: a module-level current value, a
 * pub/sub for `useSyncExternalStore`, and best-effort localStorage persistence
 * with settings.json remaining the source of truth.
 */

export type ThemePreference = "system" | "light" | "dark";

export const THEME_PREFERENCES: ThemePreference[] = ["system", "light", "dark"];

const STORAGE_KEY = "carpo.theme";

const DARK_MEDIA = "(prefers-color-scheme: dark)";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** The resolved scheme a given preference produces right now. */
export function resolveTheme(
  preference: ThemePreference
): Extract<ThemePreference, "light" | "dark"> {
  if (preference !== "system") return preference;
  try {
    return window.matchMedia(DARK_MEDIA).matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function detectInitialPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isThemePreference(stored)) return stored;
  } catch {
    // Private mode / no DOM (tests): fall through to the system default.
  }
  return "system";
}

let current: ThemePreference = detectInitialPreference();
const listeners = new Set<() => void>();

/** Applies `preference` to the document without persisting it. The DOM side
 *  effects must stay in sync with `applyStartupAppearance` in
 *  `src/lib/startup.ts`, which runs the same pair before React mounts. */
function applyToDocument(resolved: "light" | "dark"): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
}

applyToDocument(resolveTheme(current));

export function getThemePreference(): ThemePreference {
  return current;
}

/** Sets the preference, mirrors it into localStorage for the next launch's
 *  synchronous bootstrap, and notifies every active subscriber.
 *  `settingsSlice.setTheme` is the persistence path to settings.json. */
export function setThemePreference(next: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Best-effort; settings.json remains the source of truth.
  }
  const changed = next !== current;
  current = next;
  applyToDocument(resolveTheme(next));
  if (changed) listeners.forEach((listener) => listener());
}

/** Adopts a persisted preference without emitting a change (hydration path:
 *  localStorage already applied the same value before React mounted). */
export function syncThemePreference(preference: ThemePreference): void {
  if (preference === current) return;
  current = preference;
  applyToDocument(resolveTheme(preference));
}

/** Watches the OS scheme while the preference is "system". One global
 *  subscription for the process; attach from the app shell. Returns the
 *  teardown, so callers in tests can detach deterministically. */
export function watchSystemTheme(): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const media = window.matchMedia(DARK_MEDIA);
  const onChange = () => {
    if (current !== "system") return;
    applyToDocument(resolveTheme("system"));
    listeners.forEach((listener) => listener());
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
