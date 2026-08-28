import { isTauriRuntime } from "./runtime";
import { getThemePreference, resolveTheme } from "./theme";

/**
 * Themes the first paint synchronously, before React mounts. Settings
 * hydration is async and would arrive a frame too late; the theme module
 * mirrors the preference into localStorage (same trick as the language
 * catalog) so this read is synchronous and flash-free.
 */
export function applyStartupAppearance(): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(getThemePreference());
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
}

/** Forces one fallback-font layout in a fresh desktop WebView. This prevents
 * the first OCR result containing CJK, symbols, or emoji from briefly drawing
 * missing-glyph boxes and then shifting once the fallback font loads. */
export function prewarmFallbackFonts(): void {
  if (!isTauriRuntime() || typeof document === "undefined") return;
  const span = document.createElement("span");
  span.textContent = "中文繁體日本語かなカナ한국어 ∑√∞ ✓✕ 📄";
  span.setAttribute("aria-hidden", "true");
  Object.assign(span.style, {
    position: "fixed",
    left: "-10000px",
    top: "-10000px",
    visibility: "hidden",
    whiteSpace: "nowrap",
    fontFamily: "var(--font-sans)",
  });
  document.body.appendChild(span);
  void span.getBoundingClientRect();
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => span.remove());
  });
}
