/**
 * Document assembly for grouped OCR. Ports `newspaper_ocr.py:2532-2549`
 * verbatim — fixture-tested in `format-doc.test.ts`.
 *
 * Format:
 * ```
 * {newspaperName}\n{newspaperDate}\n\n{title1}\n{body1}\n\n{title2}\n{body2}\n...
 * ```
 * with a final `rstrip()` over the joined string.
 *
 * Title fallback: when an article carries no title, the first non-empty line
 * of the OCR text becomes the title and is stripped from the body. This
 * matches the Python "first-line as title" rescue path for un-labelled
 * articles.
 */
export interface AssemblyArticle {
  /** May be empty/whitespace — falls back to the OCR text's first line. */
  title: string;
  /** The raw OCR text (may be multi-line, may be empty). */
  text: string;
}

export interface AssemblyInput {
  newspaperName: string;
  newspaperDate: string;
  articles: AssemblyArticle[];
}

export function assembleDocument(input: AssemblyInput): string {
  // Skip the header block entirely when both header fields are empty —
  // otherwise the joined output starts with `\n\n\n` which scrolls the first
  // article out of view in a small drawer. Python's tool always had non-empty
  // newspaper name/date so the parity tests don't exercise this case.
  const hasHeader =
    input.newspaperName.length > 0 || input.newspaperDate.length > 0;
  const parts: string[] = hasHeader
    ? [input.newspaperName, input.newspaperDate, ""]
    : [];

  for (const art of input.articles) {
    let title = art.title;
    let text = art.text;
    // Python: `if art["title"]:` — only an empty string is falsy. A
    // whitespace-only title is kept as-is for byte-for-byte parity.
    if (!title) {
      const lines = text.trim().split("\n");
      title = lines.length > 0 && lines[0] ? lines[0] : "（无标题）";
      text = lines.length > 1 ? lines.slice(1).join("\n") : "";
    }
    parts.push(title);
    parts.push(text.trim());
    parts.push("");
  }

  return parts.join("\n").replace(/\s+$/u, "");
}
