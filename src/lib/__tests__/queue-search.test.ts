import { afterEach, describe, expect, it } from "vitest";
import { useStore } from "@/store";
import {
  activateQueueSearchHit,
  matchSearchRanges,
  queuePlainText,
  queueSearchInput,
  searchDocument,
  searchQueueFile,
  type QueueSearchInput,
} from "../queue-search";

const initial = useStore.getState();
afterEach(() => useStore.setState(initial, true));
const file = (patch: Partial<QueueSearchInput> = {}): QueueSearchInput => ({
  id: "a",
  name: "报纸.pdf",
  newspaper: "",
  pages: [],
  stories: [],
  ...patch,
});
const search = (input: QueueSearchInput, query: string) =>
  searchQueueFile(input, searchDocument(query).folded);

describe("queue search", () => {
  it("folds Chinese variants, width, case and whitespace while preserving source offsets", () => {
    const source = "甲 申\n報ＡＢＣ　乙";
    const ranges = matchSearchRanges(
      searchDocument(source),
      searchDocument("申报 abc").folded,
    );
    expect(ranges.map(([a, b]) => source.slice(a, b))).toEqual([
      "申\n報ＡＢＣ",
    ]);
    expect(
      search(file({ name: "申報１９３６.pdf" }), "申报1936")?.nameRanges,
    ).toEqual([[0, 6]]);
  });

  it("strips Paddle markup and entity syntax without searching attributes", () => {
    expect(
      queuePlainText(
        '<table class="needle"><tr><td>申&nbsp;報&#x4e2d;</td></tr></table>',
      ),
    ).toBe("申 報中");
    const input = file({
      pages: [
        {
          number: 2,
          text: '<div class="needle">申報</div>',
          edited: false,
          blocks: [],
        },
      ],
    });
    expect(search(input, "needle")).toBeNull();
    expect(search(input, "申报")?.hits[0]?.excerpt).toBe("申報");
  });

  it("keeps every occurrence, including adjacent hits, and locates its source block", () => {
    const result = search(
      file({
        pages: [
          {
            number: 3,
            text: "",
            edited: false,
            blocks: [{ index: 7, text: "新闻".repeat(65) }],
          },
        ],
      }),
      "新闻",
    );
    expect(result?.hits).toHaveLength(65);
    expect(new Set(result?.hits.map((hit) => hit.id)).size).toBe(65);
    expect(result?.hits[64]?.target).toEqual({
      kind: "page",
      page: 3,
      blockIndex: 7,
    });
  });

  it("maps edited text by context and repeated occurrences, and leaves unknown locations unset", () => {
    const base = {
      number: 2,
      edited: true,
      blocks: [
        { index: 4, text: "上海新闻" },
        { index: 9, text: "北京新闻" },
      ],
    };
    const hits = search(
      file({ pages: [{ ...base, text: "上海新闻\n北京新闻" }] }),
      "新闻",
    )!.hits;
    expect(hits.map((hit) => hit.target)).toEqual([
      { kind: "page", page: 2, blockIndex: 4 },
      { kind: "page", page: 2, blockIndex: 9 },
    ]);
    expect(
      search(file({ pages: [{ ...base, text: "完全新增文字" }] }), "新增")
        ?.hits[0]?.target,
    ).toEqual({ kind: "page", page: 2, blockIndex: undefined });
    expect(
      search(file({ pages: [{ ...base, text: "上海新词\n北京新闻" }] }), "新词")
        ?.hits[0]?.target,
    ).toEqual({ kind: "page", page: 2, blockIndex: 4 });
  });

  it("searches newspaper names, article titles and bodies without modifying their spelling", () => {
    const input = file({
      newspaper: "申報",
      stories: [{ id: "story", title: "上海報道", text: "這是報道正文" }],
    });
    expect(search(input, "申报")?.newspaperRanges).toEqual([[0, 2]]);
    const result = search(input, "报道")!;
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]?.title).toBe("上海報道");
    expect(result.hits[1]?.target).toEqual({
      kind: "article",
      articleId: "story",
    });
    expect(search(input, " \n　")).toBeNull();
  });

  it("excludes failed page results and image captions from the search input", () => {
    const input = queueSearchInput(
      [{ id: "a", name: "scan.pdf" }],
      {},
      {
        a: {
          1: { text: "错误信息", status: "failed", sourceMode: "page_image" },
          2: {
            text: "正文",
            status: "done",
            sourceMode: "paddle_json_import",
            layout: {
              index: 2,
              width: 100,
              height: 100,
              blocks: [
                {
                  label: "header_image",
                  text: "图片描述",
                  bbox: [0, 0, 10, 10],
                },
                { label: "text", text: "正文", bbox: [0, 10, 10, 20] },
                {
                  label: "table",
                  text: "<table><tr><td>表格內容</td></tr></table>",
                  imageRef: "table-preview.png",
                  bbox: [0, 20, 10, 30],
                },
              ],
            },
          },
        },
      },
      {},
      {},
    );
    expect(input[0]?.pages).toHaveLength(1);
    expect(search(input[0]!, "错误")).toBeNull();
    expect(search(input[0]!, "描述")).toBeNull();
    expect(
      search(
        file({
          pages: [
            {
              number: 4,
              text: "图片描述",
              edited: false,
              hasLayout: true,
              blocks: [],
            },
          ],
        }),
        "描述",
      ),
    ).toBeNull();
    expect(search(input[0]!, "表格内容")?.hits[0]?.target).toEqual({
      kind: "page",
      page: 2,
      blockIndex: 2,
    });
    expect(search(input[0]!, "正文")?.hits[0]?.target).toEqual({
      kind: "page",
      page: 2,
      blockIndex: 1,
    });
  });

  it("activates page and cross-page article hits using the existing canvas focus state", () => {
    const s = useStore.getState();
    s.addFile({
      id: "a",
      name: "scan.pdf",
      path: "/scan.pdf",
      ext: "pdf",
      kind: "pdf",
      pdfTotal: 8,
    });
    const pageHit = search(
      file({
        pages: [
          {
            number: 7,
            text: "",
            edited: false,
            blocks: [{ index: 3, text: "新闻" }],
          },
        ],
      }),
      "新闻",
    )!.hits[0]!;
    activateQueueSearchHit(useStore.getState(), pageHit);
    expect(useStore.getState()).toMatchObject({
      currentFileId: "a",
      currentPage: 7,
      recognitionMode: "whole_file",
      selectedQueueFileIds: ["a"],
      editingLayoutBlock: { a: { page: 7, index: 3 } },
    });
    s.addBlock("a", 4, {
      id: "box",
      x: 1,
      y: 2,
      w: 30,
      h: 40,
      articleId: null,
      articleOrder: null,
    });
    s.addArticle("a", 4, { id: "story", num: 1, title: "报道" }, ["box"]);
    const articleHit = search(
      file({ stories: [{ id: "story", title: "报道", text: "新闻" }] }),
      "新闻",
    )!.hits[0]!;
    activateQueueSearchHit(useStore.getState(), articleHit);
    expect(useStore.getState()).toMatchObject({
      currentPage: 4,
      recognitionMode: "grouped",
      selectedArticleIds: ["story"],
      editingLayoutBlock: { a: null },
      focusedRegion: {
        a: {
          rects: [{ page: 4, rect: { x: 1, y: 2, width: 30, height: 40 } }],
        },
      },
    });
  });
});
