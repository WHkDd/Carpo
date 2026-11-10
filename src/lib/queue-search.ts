import { Converter } from "opencc-js/t2cn";
import type { AppStore } from "@/store";
import type { FileEntry } from "./ipc-types";
import type { DocumentState } from "@/store/pageStateSlice";
import type { RecognizedPage } from "@/store/jobSlice";
import { isOcrFailureText } from "./batch-export";

export type SearchRange = [start: number, end: number];
export type QueueSearchTarget =
  | { kind: "page"; page: number; blockIndex?: number }
  | { kind: "article"; articleId: string };
export interface QueueSearchHit {
  id: string;
  fileId: string;
  target: QueueSearchTarget;
  title: string;
  titleRanges: SearchRange[];
  excerpt: string;
  excerptRanges: SearchRange[];
}
export interface QueueSearchResult {
  nameRanges: SearchRange[];
  newspaperRanges: SearchRange[];
  hits: QueueSearchHit[];
}
export interface QueueSearchInput {
  id: string;
  name: string;
  newspaper: string;
  pages: {
    number: number;
    text: string;
    edited: boolean;
    hasLayout?: boolean;
    blocks: { index: number; text: string }[];
  }[];
  stories: { id: string; title: string; text: string }[];
}
export const INITIAL_SEARCH_HITS = 20;
const simplify = Converter({ from: "t", to: "cn" });
const foldedCharacters = new Map<string, string>();

/** Preserve source offsets while folding Chinese variants, width and case. */
export function searchDocument(text: string) {
  let folded = "",
    offset = 0;
  const ranges: SearchRange[] = [];
  for (const char of text) {
    let part = foldedCharacters.get(char);
    if (part === undefined) {
      part = simplify(char.normalize("NFKC").toLowerCase()).replace(/\s/gu, "");
      foldedCharacters.set(char, part);
    }
    folded += part;
    for (let i = 0; i < part.length; i++)
      ranges.push([offset, offset + char.length]);
    offset += char.length;
  }
  return { text, folded, ranges };
}
type SearchDocument = ReturnType<typeof searchDocument>;

export function matchSearchRanges(
  document: SearchDocument,
  needle: string,
): SearchRange[] {
  if (!needle) return [];
  const matches: SearchRange[] = [];
  let cursor = 0;
  while (cursor < document.folded.length) {
    const at = document.folded.indexOf(needle, cursor);
    if (at < 0) break;
    const start = document.ranges[at]![0],
      end = document.ranges[at + needle.length - 1]![1];
    const previous = matches.at(-1);
    if (previous && start < previous[1])
      previous[1] = Math.max(previous[1], end);
    else matches.push([start, end]);
    cursor = at + needle.length;
  }
  return matches;
}

/** Strip Paddle markup before matching; tag attributes are never searchable. */
export function queuePlainText(text: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(
      /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (whole, entity: string) => {
        if (!entity.startsWith("#"))
          return entities[entity.toLowerCase()] ?? whole;
        const value =
          entity[1]?.toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        return value > 0 && value <= 0x10ffff
          ? String.fromCodePoint(value)
          : whole;
      },
    );
}

export function queueSearchInput(
  files: Pick<FileEntry, "id" | "name">[],
  documents: Record<string, DocumentState>,
  recognized: Record<string, Record<number, RecognizedPage>>,
  pageTexts: Record<string, Record<number, string>>,
  articleTexts: Record<string, Record<string, string>>,
): QueueSearchInput[] {
  return files.map((file) => {
    const pages = recognized[file.id] ?? {};
    const numbers = new Set(
      [...Object.keys(pages), ...Object.keys(pageTexts[file.id] ?? {})].map(
        Number,
      ),
    );
    return {
      id: file.id,
      name: file.name,
      newspaper: documents[file.id]?.newspaperName ?? "",
      pages: [...numbers]
        .sort((a, b) => a - b)
        .flatMap((number) => {
          const page = pages[number];
          const text = page?.text ?? pageTexts[file.id]?.[number] ?? "";
          if (page?.status === "failed" || isOcrFailureText(text)) return [];
          return [
            {
              number,
              text,
              edited: !!page?.textEdited,
              hasLayout: !!page?.layout?.blocks.length,
              blocks: (page?.layout?.blocks ?? []).flatMap((block, index) =>
                /(^|_)image$/.test(block.label)
                  ? []
                  : [{ index, text: queuePlainText(block.text) }],
              ),
            },
          ];
        }),
      stories: (documents[file.id]?.articles ?? []).map((article) => {
        const text = articleTexts[file.id]?.[article.id] ?? "";
        return {
          id: article.id,
          title: article.title,
          text: isOcrFailureText(text) ? "" : text,
        };
      }),
    };
  });
}

function snippet(text: string, [start, end]: SearchRange): string {
  // Bound the copied context even when a long page contains thousands of hits.
  const before = Array.from(text.slice(Math.max(0, start - 26), start))
    .slice(-12)
    .join("");
  const after = Array.from(text.slice(end, end + 74))
    .slice(0, 36)
    .join("");
  return (
    (start > before.length ? "…" : "") +
    before +
    text.slice(start, end) +
    after +
    (end + after.length < text.length ? "…" : "")
  );
}

function editedBlock(
  document: SearchDocument,
  range: SearchRange,
  ordinal: number,
  needle: string,
  blocks: { index: number; folded: string }[],
  exact: boolean,
  occurrenceBlocks: number[],
): number | undefined {
  if (exact) {
    let lower = 0,
      upper = document.ranges.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (document.ranges[middle]![0] < range[0]) lower = middle + 1;
      else upper = middle;
    }
    const prefix = lower;
    let offset = 0;
    for (const block of blocks) {
      offset += block.folded.length;
      if (prefix < offset) return block.index;
    }
  }
  const [start, end] = range;
  const characters = new Set(needle);
  for (const width of [8, 4, 2]) {
    const before = Array.from(
      document.text.slice(Math.max(0, start - width * 2 - 2), start),
    )
      .slice(-width)
      .join("");
    const after = Array.from(document.text.slice(end, end + width * 2 + 2))
      .slice(0, width)
      .join("");
    const word = document.text.slice(start, end);
    for (const context of [
      before + word + after,
      before + word,
      word + after,
    ]) {
      const folded = searchDocument(context).folded;
      if (![...folded].some((char) => !characters.has(char))) continue;
      const matches = blocks.filter(
        (block) => folded && block.folded.includes(folded),
      );
      if (matches.length === 1) return matches[0]!.index;
    }
  }
  if (occurrenceBlocks[ordinal] !== undefined) return occurrenceBlocks[ordinal];
  for (const width of [8, 4, 2]) {
    for (const context of [
      Array.from(document.text.slice(Math.max(0, start - width * 2 - 2), start))
        .slice(-width)
        .join(""),
      Array.from(document.text.slice(end, end + width * 2 + 2))
        .slice(0, width)
        .join(""),
    ]) {
      const folded = searchDocument(context).folded;
      const matches = blocks.filter(
        (block) => folded && block.folded.includes(folded),
      );
      if (matches.length === 1) return matches[0]!.index;
    }
  }
  return undefined;
}

/** Search one file at a time so the caller can yield between files and cancel. */
export function searchQueueFile(
  file: QueueSearchInput,
  needle: string,
): QueueSearchResult | null {
  if (!needle) return null;
  const result: QueueSearchResult = {
    nameRanges: matchSearchRanges(searchDocument(file.name), needle),
    newspaperRanges: matchSearchRanges(searchDocument(file.newspaper), needle),
    hits: [],
  };
  const append = (
    text: string,
    target: QueueSearchTarget,
    key: string,
    title = "",
    titleRanges: SearchRange[] = [],
    resolve?: (range: SearchRange, ordinal: number) => QueueSearchTarget,
  ) => {
    const document = searchDocument(queuePlainText(text));
    matchSearchRanges(document, needle).forEach((range, ordinal) => {
      const excerpt = snippet(document.text, range);
      result.hits.push({
        id: `${file.id}:${key}:${range[0]}`,
        fileId: file.id,
        target: resolve?.(range, ordinal) ?? target,
        title,
        titleRanges,
        excerpt,
        excerptRanges: matchSearchRanges(searchDocument(excerpt), needle),
      });
    });
  };
  for (const page of file.pages) {
    if (!page.edited && (page.hasLayout || page.blocks.length)) {
      for (const block of page.blocks)
        append(
          block.text,
          { kind: "page", page: page.number, blockIndex: block.index },
          `page:${page.number}:${block.index}`,
        );
    } else {
      const document = searchDocument(queuePlainText(page.text));
      const blocks = page.blocks.map((block) => ({
        index: block.index,
        folded: searchDocument(block.text).folded,
      }));
      const exact =
        blocks.map((block) => block.folded).join("") === document.folded;
      const occurrenceBlocks: number[] = [];
      if (!exact)
        for (const block of blocks) {
          let cursor = 0;
          while (cursor < block.folded.length) {
            const at = block.folded.indexOf(needle, cursor);
            if (at < 0) break;
            occurrenceBlocks.push(block.index);
            cursor = at + needle.length;
          }
        }
      append(
        page.text,
        { kind: "page", page: page.number },
        `page:${page.number}`,
        "",
        [],
        (range, ordinal) => ({
          kind: "page",
          page: page.number,
          blockIndex: editedBlock(
            document,
            range,
            ordinal,
            needle,
            blocks,
            exact,
            occurrenceBlocks,
          ),
        }),
      );
    }
  }
  for (const story of file.stories) {
    const title = queuePlainText(story.title);
    const titleRanges = matchSearchRanges(searchDocument(title), needle);
    const target: QueueSearchTarget = { kind: "article", articleId: story.id };
    if (titleRanges.length)
      result.hits.push({
        id: `${file.id}:article:${story.id}:title`,
        fileId: file.id,
        target,
        title,
        titleRanges,
        excerpt: "",
        excerptRanges: [],
      });
    append(story.text, target, `article:${story.id}`, title, titleRanges);
  }
  return result.nameRanges.length ||
    result.newspaperRanges.length ||
    result.hits.length
    ? result
    : null;
}

export function activateQueueSearchHit(
  state: AppStore,
  hit: QueueSearchHit,
): void {
  if (!state.files.some((file) => file.id === hit.fileId)) return;
  state.selectQueueFile(hit.fileId, [hit.fileId]);
  state.setRecognitionMode(
    hit.target.kind === "page" ? "whole_file" : "grouped",
  );
  state.setEditingLayoutBlock(hit.fileId, null);
  state.setEditingBlock(hit.fileId, null);
  state.setFocusedRegion(hit.fileId, null);
  if (hit.target.kind === "page") {
    state.setCurrentPage(hit.fileId, hit.target.page);
    if (hit.target.blockIndex !== undefined)
      state.setEditingLayoutBlock(hit.fileId, {
        page: hit.target.page,
        index: hit.target.blockIndex,
      });
  } else {
    const articleId = hit.target.articleId;
    const article = state.documentStates[hit.fileId]?.articles.find(
      (entry) => entry.id === articleId,
    );
    state.setSelectedArticleIds([articleId]);
    const firstPage = article?.blockRefs[0]?.page;
    if (firstPage !== undefined) {
      state.setCurrentPage(hit.fileId, firstPage);
      const rects = article!.blockRefs
        .filter((ref) => ref.page === firstPage)
        .flatMap((ref) => {
          const block = state
            .getPageState(hit.fileId, ref.page)
            .blocks.find((entry) => entry.id === ref.blockId);
          return block
            ? [
                {
                  page: ref.page,
                  rect: {
                    x: block.x,
                    y: block.y,
                    width: block.w,
                    height: block.h,
                  },
                },
              ]
            : [];
        });
      if (rects.length)
        state.setFocusedRegion(hit.fileId, { rects: [rects[0]!] });
    }
  }
}
