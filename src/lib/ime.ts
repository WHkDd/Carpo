/**
 * IME composition guard.
 *
 * While a CJK input method is composing, Enter selects a candidate — it is
 * *not* a submit. Any `keydown` handler that treats `e.key === "Enter"` as
 * "commit" will fire mid-composition and write the un-committed romaji/pinyin
 * buffer into the store, then close the editor. For a tool whose article
 * titles are almost always Chinese, that is a data-loss bug on the primary
 * keyboard path, so every Enter handler behind a text field routes through
 * here first.
 */

interface CompositionKeyEvent {
  isComposing: boolean;
  keyCode: number;
}

type MaybeReactKeyEvent =
  | CompositionKeyEvent
  | { nativeEvent: CompositionKeyEvent };

/**
 * True when this `keydown` belongs to an in-flight IME composition and the
 * caller should ignore it.
 *
 * `keyCode === 229` is the fallback signal: WebView2 and older WebKit builds
 * do not always set `isComposing` on the composition keydown, but both have
 * always reported the 229 sentinel keyCode. Checking only `isComposing` leaves
 * the Windows path broken, which is exactly the platform we can't easily test
 * on every change.
 */
export function isImeCommit(e: MaybeReactKeyEvent): boolean {
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  return native.isComposing || native.keyCode === 229;
}
