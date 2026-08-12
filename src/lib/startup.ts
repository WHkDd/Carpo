import { isTauriRuntime } from "./runtime";

/** Keeps the WebView's prepaint and React's current light-only UI in sync. */
export function applyStartupAppearance(): void {
  if (typeof document === "undefined") return;
  // Dark mode is outside this batch. Do not expose a partial preference or
  // dark form controls before the complete token set and system listener
  // exist; the only startup contract here is a flash-free light first frame.
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "light";
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
