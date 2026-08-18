import type {
  NonSecretSettings,
  ProofreadCategory,
  ProofreadResultEntry,
  ProofreadSuggestion,
  ProofreadUnit,
  Provider,
} from "./ipc-types";
import type { LayoutPage } from "./layout-document";

/**
 * Frontend half of the LLM proofread feature: verdicts, whitespace
 * normalization (the mirror of `ocr::proofread::normalize_whitespace`), and
 * the pure text surgery that turns accepted suggestions back into a page or
 * article. Everything here is unit-testable; the components only wire state
 * to these functions.
 */

/** One suggestion plus the verdict the user (or the default policy) gave it. */
export type SuggestionVerdict = "pending" | "accepted" | "rejected" | "edited";

export interface ProofreadSuggestionWithVerdict extends ProofreadSuggestion {
  verdict: SuggestionVerdict;
  /** Replacement text when `verdict === "edited"`. */
  editedAfter?: string;
}

/** Where a review's text lives. Reconstructed from the opaque wire key
 *  (`page:12` / `article:a_xxx`) by `parseProofreadTargetKey` — the same
 *  prefix scheme the trigger uses when it builds the units. */
export type ProofreadTarget =
  | { mode: "whole_file"; page: number }
  | { mode: "grouped"; articleId: string };

export interface ProofreadReview {
  target: ProofreadTarget;
  /** Snapshot of the text that was proofread (the unit text sent to the
   *  backend at job start). The stale check compares the live text against
   *  this before anything is applied. */
  baseText: string;
  suggestions: ProofreadSuggestionWithVerdict[];
  model: string;
  /** Suggestions the model sent but anchor validation dropped. */
  discarded: number;
  status: "pending" | "applied";
  createdAt: number;
  /** The text written when the review was applied — undo restores `baseText`
   *  and refuses to run if the user edited the text after applying. */
  appliedText?: string;
  /** Set when the review was applied: how many accepted suggestions were
   *  skipped because an earlier applied suggestion already touched the same
   *  original-text interval (or insertion point). Shown next to the applied
   *  banner so a skipped correction is never silent. */
  appliedConflictSkipped?: number;
  /** Set when this unit failed to proofread at all (network / parse error). */
  error?: string;
}

/** The three categories the review defaults to *accepted*: with the default
 *  policy, nine out of ten pages are applied with a glance and the batch
 *  buttons never get touched. `semantic` / `layout` start as `pending` — a
 *  historical transcript must keep its original wording. */
export const DEFAULT_ACCEPT_CATEGORIES: ReadonlySet<ProofreadCategory> =
  new Set(["punct", "charform", "garble"]);

/** Providers that can run a chat call at all. PaddleOCR is recognition-only
 *  and the backend rejects it for proofreading; the UI must offer the same
 *  answer before a job is started. */
export const CHAT_PROVIDERS: readonly Provider[] = [
  "openai",
  "openrouter",
  "openai_compatible",
];

export function isChatProvider(provider: Provider): boolean {
  return CHAT_PROVIDERS.includes(provider);
}

/** Mirrors `ocr::resolve_proofread_provider` in Rust: an explicit
 *  `proofread_provider` wins, otherwise the OCR provider. */
export function resolveProofreadProvider(
  settings: NonSecretSettings
): Provider {
  return settings.proofread_provider ?? settings.provider;
}

/** Mirrors `ocr::resolve_proofread_model` in Rust: an explicit
 *  `proofread_model` wins, otherwise the resolved provider's OCR model
 *  field. */
export function resolveProofreadModel(settings: NonSecretSettings): string {
  if (settings.proofread_model.trim().length > 0) {
    return settings.proofread_model.trim();
  }
  switch (resolveProofreadProvider(settings)) {
    case "paddleocr":
      return settings.paddle_model;
    case "openai":
      return settings.openai_model;
    case "openrouter":
      return settings.openrouter_model;
    case "openai_compatible":
      return settings.openai_compatible_model;
  }
}

/**
 * Folds whitespace exactly like the backend's anchor validation: every
 * whitespace character is *deleted*, not collapsed to a space. In
 * vertical-script Chinese text any whitespace between characters is a layout
 * artifact, and the model quotes fragments with or without those breaks —
 * deleting them on both sides makes the rendering of a line break
 * irrelevant. Read-only: the original text is never modified.
 */
export function normalizeWhitespace(s: string): string {
  let out = "";
  for (const ch of s) {
    if (!/\s/.test(ch)) out += ch;
  }
  return out;
}

/**
 * Locates a suggestion's anchor in the raw text. The backend has already
 * validated the anchor against the *submitted* text, so a `null` here means
 * the text changed since the review was created — the same condition the
 * stale banner detects. Returns the raw-text character span of `before`,
 * plus `rawIndices`: the raw offset of every non-whitespace character inside
 * that span, in code-point order. `applySuggestions` treats those offsets as
 * slot boundaries when it writes the correction back — a slot is one
 * character plus the whitespace that follows it, so whitespace travels with
 * the character it belongs to.
 *
 * Mirror of the backend's rule: `context_before + before`, normalized as one
 * string (the boundary between them may carry whitespace in the model's
 * rendering but none in the source), must occur exactly once. Overlapping
 * candidates are distinct positions and are all counted: `哈哈哈` holds
 * `哈哈` at offsets 0 and 1, so that anchor reads as ambiguous and is
 * refused — the backend applies the same rule, and the two sides share a
 * contract table of test cases.
 */
export function findSuggestionSpan(
  text: string,
  suggestion: Pick<ProofreadSuggestion, "before" | "context_before">
): { start: number; end: number; rawIndices: number[] } | null {
  if (suggestion.before.trim().length === 0) return null;
  // Build the normalized text and a map back from normalized offsets to raw
  // offsets, once per call. Iteration is per *code point*, not per UTF-16
  // code unit: the slot projection in `applySuggestions` walks `before` as
  // code points, and the two granularities must agree — one astral character
  // would otherwise shift every later slot by one.
  const norm: string[] = [];
  const toRaw: number[] = [];
  let raw = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) {
      norm.push(ch);
      toRaw.push(raw);
    }
    raw += ch.length;
  }
  const needleCps = Array.from(
    normalizeWhitespace(`${suggestion.context_before}${suggestion.before}`)
  );
  if (needleCps.length === 0) return null;
  // Count every occurrence, advancing one code point at a time: overlapping
  // candidates are distinct positions, and the first one is not the anchor
  // the model meant. This walk discovers exactly the match set the backend's
  // char-boundary scan finds (a needle can never begin inside a surrogate
  // pair — its first character is a real character).
  let start = -1;
  let occurrences = 0;
  for (let i = 0; i + needleCps.length <= norm.length; i++) {
    if (norm[i] !== needleCps[0]) continue;
    let match = true;
    for (let j = 1; j < needleCps.length; j++) {
      if (norm[i + j] !== needleCps[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      occurrences += 1;
      start = i;
    }
  }
  if (occurrences !== 1) return null;
  const beforeStart =
    start + Array.from(normalizeWhitespace(suggestion.context_before)).length;
  const beforeCps = Array.from(normalizeWhitespace(suggestion.before));
  const beforeEnd = beforeStart + beforeCps.length;
  if (beforeEnd === beforeStart) return null;
  const rawStart = toRaw[beforeStart];
  const rawEndIndex = toRaw[beforeEnd - 1];
  if (rawStart === undefined || rawEndIndex === undefined) return null;
  const lastCp = beforeCps[beforeCps.length - 1];
  return {
    start: rawStart,
    end: rawEndIndex + (lastCp ? lastCp.length : 0),
    rawIndices: toRaw.slice(beforeStart, beforeEnd),
  };
}

export interface ApplySuggestionsResult {
  /** The text with every applicable correction written back. */
  text: string;
  /** Suggestions skipped because an earlier applied suggestion already
   *  touched an overlapping original-text interval — or sits on the same
   *  insertion point. Applying both would silently drop one of the edits,
   *  so the second one is refused and counted instead. */
  conflictSkipped: number;
}

/** One applied suggestion's claim on the original text: a character
 *  interval for replaced / deleted characters, or a zero-length insertion
 *  point (`start === end`) for a pure insertion. */
interface TouchedInterval {
  start: number;
  end: number;
}

interface SpanWithIndices {
  start: number;
  end: number;
  rawIndices: number[];
}

/** Minimal diff op over the mid region of a `before`/`after` pair. `slot`
 *  and `at` are indexes into the mid arrays — `rebuildSpan` maps them back
 *  to raw offsets. */
type DiffOp =
  | { type: "keep"; slot: number }
  | { type: "delete"; slot: number }
  | { type: "insert"; chars: string[]; at: number };

/** Minimal edit script between two code-point arrays, via LCS. Insertions
 *  carry the mid-slot boundary (`at`) they sit on, so the projection can
 *  turn a standalone insert-run into an insertion point in original
 *  coordinates. The degenerate guard keeps the projection linear when a
 *  pathological `before`/`after` pair would make the DP table huge. */
function diffOps(midB: string[], midA: string[]): DiffOp[] {
  const n = midB.length;
  const m = midA.length;
  if (n * m > 10_000) {
    // Degenerate: treat the whole mid region as one unequal-length
    // replacement — a single delete-run followed by a single insert-run.
    const ops: DiffOp[] = [];
    for (let i = 0; i < n; i++) ops.push({ type: "delete", slot: i });
    if (m > 0) ops.push({ type: "insert", chars: [...midA], at: n });
    return ops;
  }
  // dp[i][j] = LCS length of midB[0..i) × midA[0..j).
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] =
        midB[i - 1] === midA[j - 1]
          ? dp[i - 1]![j - 1]! + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  // Backtrace. Tie-break keep → insert → delete, so a replacement region
  // comes out as one delete-run followed by one insert-run — the shape the
  // slot projection rules are written for.
  const ops: DiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && midB[i - 1] === midA[j - 1]) {
      ops.push({ type: "keep", slot: i - 1 });
      i -= 1;
      j -= 1;
    } else if (j > 0 && dp[i]![j] === dp[i]![j - 1]!) {
      ops.push({ type: "insert", chars: [midA[j - 1]!], at: i });
      j -= 1;
    } else {
      ops.push({ type: "delete", slot: i - 1 });
      i -= 1;
    }
  }
  ops.reverse();
  return ops;
}

/**
 * Rebuilds one suggestion's raw-text span from the verdict's replacement.
 * The span's characters become *slots*: slot i is the raw interval
 * [rawIndices[i], rawIndices[i+1]) — one character plus the whitespace that
 * follows it. Writing back slot by slot is what keeps a correction from
 * eating the line breaks around it. Returns the rebuilt span text and the
 * original-text intervals the edit actually touched (delete-runs and
 * standalone insertion points), which `applySuggestions` feeds into its
 * overlap model.
 */
function rebuildSpan(
  raw: string,
  span: SpanWithIndices,
  beforeCps: string[],
  afterCps: string[]
): { text: string; touched: TouchedInterval[] } {
  const { end, rawIndices } = span;
  const slotEnd = (i: number): number =>
    i + 1 < rawIndices.length ? rawIndices[i + 1]! : end;
  const slotText = (i: number): string => raw.slice(rawIndices[i]!, slotEnd(i));
  const slotWhitespace = (i: number): string => {
    const at = rawIndices[i]!;
    const charLen = raw.codePointAt(at)! > 0xffff ? 2 : 1;
    return raw.slice(at + charLen, slotEnd(i));
  };
  // Strip the common prefix and suffix (code points) so the diff only runs
  // over the part that actually changed.
  let p = 0;
  const minLen = Math.min(beforeCps.length, afterCps.length);
  while (p < minLen && beforeCps[p] === afterCps[p]) p += 1;
  let s = 0;
  while (
    s < minLen - p &&
    beforeCps[beforeCps.length - 1 - s] === afterCps[afterCps.length - 1 - s]
  ) {
    s += 1;
  }
  const midB = beforeCps.slice(p, beforeCps.length - s);
  const midA = afterCps.slice(p, afterCps.length - s);
  const ops = diffOps(midB, midA);
  // Raw offset of a mid-slot boundary: insertion `at` sits between mid-slot
  // at-1 and mid-slot at (the end of the span when the mid region ends
  // there and no suffix follows).
  const midBoundary = (at: number): number =>
    at < midB.length
      ? rawIndices[p + at]!
      : s > 0
        ? rawIndices[p + midB.length]!
        : end;

  const touched: TouchedInterval[] = [];
  let out = "";
  for (let i = 0; i < p; i++) out += slotText(i);
  let k = 0;
  while (k < ops.length) {
    const op = ops[k]!;
    if (op.type === "keep") {
      out += slotText(p + op.slot);
      k += 1;
      continue;
    }
    if (op.type === "insert") {
      out += op.chars.join("");
      const boundary = midBoundary(op.at);
      touched.push({ start: boundary, end: boundary });
      k += 1;
      continue;
    }
    // Delete-run.
    let runEnd = k;
    while (runEnd < ops.length && ops[runEnd]!.type === "delete") runEnd += 1;
    const delSlots = ops
      .slice(k, runEnd)
      .map((o) => p + (o as Extract<DiffOp, { type: "delete" }>).slot);
    const first = delSlots[0]!;
    const last = delSlots[delSlots.length - 1]!;
    touched.push({ start: rawIndices[first]!, end: slotEnd(last) });
    // The following insert-run, if any.
    const insChars: string[] = [];
    let next = runEnd;
    while (next < ops.length && ops[next]!.type === "insert") {
      insChars.push(
        ...(ops[next] as Extract<DiffOp, { type: "insert" }>).chars
      );
      next += 1;
    }
    if (insChars.length === 0) {
      // Pure deletion: characters and the run's internal whitespace go, but
      // the last slot's trailing whitespace stays (see the `applySuggestions`
      // contract below — the dangling break is deliberate).
      out += slotWhitespace(last);
    } else if (insChars.length === delSlots.length) {
      // Equal-length replacement: the j-th replacement character is written
      // into the j-th slot; each slot's whitespace is kept as-is.
      for (let t = 0; t < delSlots.length; t += 1) {
        out += insChars[t]! + slotWhitespace(delSlots[t]!);
      }
    } else {
      // Unequal-length replacement: all replacement characters land at the
      // first slot's character position; the run's internal whitespace is
      // dropped, but the last slot's trailing whitespace is kept.
      out += insChars.join("") + slotWhitespace(last);
    }
    k = next;
  }
  for (let i = beforeCps.length - s; i < beforeCps.length; i++) {
    out += slotText(i);
  }
  return { text: out, touched };
}

/**
 * Applies every accepted / edited suggestion to the raw text, in source
 * order, and reports how many had to be skipped: a suggestion whose span
 * overlaps a span an earlier suggestion already rebuilt, or whose span
 * strictly contains an earlier suggestion's insertion point, is refused and
 * counted. Applied spans never overlap — the output is concatenated span by
 * span, so two overlapping spans would emit their shared characters twice;
 * a skipped correction beats a duplicated or misplaced one.
 *
 * Whitespace ownership — the five projection rules. A suggestion's `before`
 * spans raw text that may carry newlines between characters (vertical
 * OCR); its characters become *slots*, slot i being the raw interval
 * [rawIndices[i], rawIndices[i+1]) — one character plus the whitespace that
 * follows it. The corrected span is rebuilt slot by slot:
 *
 * 1. keep(i)：原样输出槽位 i 的完整原文区间（字符 ＋ 其后空白）。未改动字符周围的空白因此必然保留。
 * 2. 等长替换：delete-run 与 insert-run 的 code point 数相同时 1:1 配对——第 j 个替换字符写进第 j 个槽位，该槽位的空白照旧输出。
 * 3. 非等长替换：整段替换文本落在 run 首槽的字符位置；run 内部各槽位的空白丢弃，但保留 run 末槽的尾随空白。
 * 4. 纯删除：字符与 run 内部空白一并丢弃，同样保留末槽尾随空白——可能留下一处悬空换行，这是刻意选择：对报刊原文，留一个断行远好过静默地把两行并成一行。
 * 5. 纯插入：在当前位置直接写入，不产生也不消耗空白。
 *
 * Two fixed semantics go with these rules: whitespace inside `after` /
 * `editedAfter` is inserted verbatim, never normalized; and the diff plus
 * `rawIndices` are always code-point granular, never UTF-16 code units.
 * The Rust anchor pass (`ocr::proofread::anchor_suggestions`) only checks
 * uniqueness and never writes text back — this module alone owns the
 * whitespace contract.
 */
export function applySuggestions(
  text: string,
  suggestions: ProofreadSuggestionWithVerdict[]
): ApplySuggestionsResult {
  // Resolve every accepted / edited suggestion against the ORIGINAL text, in
  // source order. The backend validated each anchor against this very text,
  // so every resolution is independent of the others; equal spans are broken
  // by the suggestion's original index, keeping the order deterministic.
  const resolved = suggestions
    .map((s, index) => {
      if (s.verdict !== "accepted" && s.verdict !== "edited") return null;
      const span = findSuggestionSpan(text, s);
      if (!span) return null;
      return { s, index, span };
    })
    .filter(
      (
        entry
      ): entry is {
        s: ProofreadSuggestionWithVerdict;
        index: number;
        span: SpanWithIndices;
      } => entry !== null
    )
    .sort(
      (a, b) => a.span.start - b.span.start || a.index - b.index
    );

  const touched: TouchedInterval[] = [];
  let conflictSkipped = 0;
  let out = "";
  let cursor = 0;
  for (const { s, span } of resolved) {
    const replacement = s.verdict === "edited" ? (s.editedAfter ?? "") : s.after;
    const beforeCps = Array.from(normalizeWhitespace(s.before));
    const afterCps = Array.from(replacement);
    if (
      beforeCps.length === afterCps.length &&
      beforeCps.every((c, i) => c === afterCps[i])
    ) {
      // Identical after normalization — no text change, so the suggestion
      // neither writes nor claims anything.
      continue;
    }
    // Overlap model, two rules. (1) An applied suggestion claims its WHOLE
    // span, kept slots included: the output is concatenated span by span, so
    // a later span overlapping any part of an applied one would re-emit the
    // shared characters (`叁月五日` + `五日下芋` must not write 五日 twice).
    // `resolved` is sorted by span start and `cursor` is the previous
    // applied span's end, so `span.start < cursor` is exactly "overlaps an
    // applied span" — it also subsumes the delete/replace intervals in
    // `touched`. (2) A zero-length insertion point blocks a span that
    // strictly contains it; an insertion at the span's own boundary
    // survives, because the rebuild never touches it.
    const blocked =
      span.start < cursor ||
      touched.some((t) =>
        t.start === t.end
          ? span.start < t.start && t.start < span.end
          : span.start < t.end && t.start < span.end
      );
    if (blocked) {
      conflictSkipped += 1;
      continue;
    }
    const rebuilt = rebuildSpan(text, span, beforeCps, afterCps);
    out += text.slice(cursor, span.start) + rebuilt.text;
    touched.push(...rebuilt.touched);
    cursor = span.end;
  }
  out += text.slice(cursor);
  return { text: out, conflictSkipped };
}

/** Builds the opaque unit key for a target. `page:12` / `article:a_xxx`. */
export function proofreadKeyFor(target: ProofreadTarget): string {
  return target.mode === "whole_file"
    ? `page:${target.page}`
    : `article:${target.articleId}`;
}

/** Inverse of `proofreadKeyFor`; `null` for a key this app never minted. */
export function parseProofreadTargetKey(key: string): ProofreadTarget | null {
  if (key.startsWith("page:")) {
    const page = Number(key.slice("page:".length));
    if (!Number.isFinite(page) || page < 1) return null;
    return { mode: "whole_file", page };
  }
  if (key.startsWith("article:")) {
    const articleId = key.slice("article:".length);
    if (articleId.length === 0) return null;
    return { mode: "grouped", articleId };
  }
  return null;
}

/**
 * Builds a review out of a job result. `null` when the target key cannot be
 * parsed — the trigger and this factory use the same minting rules, so this
 * only fires on hand-crafted payloads. Default verdicts come from
 * `DEFAULT_ACCEPT_CATEGORIES`.
 */
export function buildProofreadReview(
  unit: ProofreadUnit,
  result: ProofreadResultEntry | undefined,
  errorMessage: string | undefined,
  now: number
): ProofreadReview | null {
  const target = parseProofreadTargetKey(unit.key);
  if (!target) return null;
  if (result) {
    return {
      target,
      baseText: unit.text,
      suggestions: result.suggestions.map((s) => ({
        ...s,
        verdict: DEFAULT_ACCEPT_CATEGORIES.has(s.category)
          ? "accepted"
          : "pending",
      })),
      model: result.model,
      discarded: result.discarded,
      status: "pending",
      createdAt: now,
    };
  }
  return {
    target,
    baseText: unit.text,
    suggestions: [],
    model: "",
    discarded: 0,
    status: "pending",
    createdAt: now,
    error: errorMessage,
  };
}

/**
 * Which layout block contains a suggestion's anchor, by index into
 * `LayoutPage.blocks`. Used to light up the canvas while reviewing: the
 * suggestion row's focus lands on the block the correction belongs to.
 * `null` when no block contains the anchor — the caller then does nothing.
 */
export function findBlockIndexForSuggestion(
  layout: LayoutPage,
  suggestion: Pick<ProofreadSuggestion, "before" | "context_before">
): number | null {
  const needle = normalizeWhitespace(
    `${suggestion.context_before}${suggestion.before}`
  );
  const fallback = normalizeWhitespace(suggestion.before);
  if (needle.length === 0 && fallback.length === 0) return null;
  for (let i = 0; i < layout.blocks.length; i++) {
    const block = layout.blocks[i];
    if (!block || block.text.trim().length === 0) continue;
    const normalized = normalizeWhitespace(block.text);
    if (needle.length > 0 && normalized.includes(needle)) return i;
    if (fallback.length > 0 && normalized.includes(fallback)) return i;
  }
  return null;
}

/** The verdicts that count as "applied" — accepted or hand-edited. */
export function appliedSuggestionCount(
  suggestions: ProofreadSuggestionWithVerdict[]
): number {
  return suggestions.filter(
    (s) => s.verdict === "accepted" || s.verdict === "edited"
  ).length;
}

/** Category chips: all accepted → click rejects them all; anything else →
 *  click accepts them all. */
export function categoryVerdictState(
  suggestions: ProofreadSuggestionWithVerdict[],
  category: ProofreadCategory
): "accept-all" | "mixed" {
  const inCategory = suggestions.filter((s) => s.category === category);
  if (inCategory.length === 0) return "accept-all";
  const allAccepted = inCategory.every((s) => s.verdict === "accepted");
  return allAccepted ? "accept-all" : "mixed";
}
