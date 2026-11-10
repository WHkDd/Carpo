import { describe, expect, it } from "vitest";
import { groupQueueFiles, sortQueueFiles } from "../queue-view";
import type { FileEntry } from "../ipc-types";
import type { DocumentState } from "@/store/pageStateSlice";

const files: FileEntry[] = ["scan10", "scan2", "scan1"].map((id) => ({
  id,
  path: `/tmp/${id}.pdf`,
  name: `${id}.pdf`,
  ext: "pdf",
  kind: "pdf",
}));
const ids = (list: FileEntry[]) => list.map((file) => file.id);
const documents: Record<string, DocumentState> = {
  scan10: {
    articles: [],
    newspaperName: "申报",
    newspaperDate: "1936-05-12",
    tags: ["甲", "乙"],
  },
  scan2: {
    articles: [],
    newspaperName: "申报",
    newspaperDate: "１９３５年",
    tags: ["乙"],
  },
};
describe("queue views", () => {
  it("uses natural file-name sorting, puts missing metadata last in both directions, and always pins stars", () => {
    expect(ids(sortQueueFiles(files, documents, [], "name", true))).toEqual([
      "scan1",
      "scan2",
      "scan10",
    ]);
    expect(ids(sortQueueFiles(files, documents, [], "date", false))).toEqual([
      "scan10",
      "scan2",
      "scan1",
    ]);
    expect(ids(sortQueueFiles(files, documents, [], "date", true))).toEqual([
      "scan2",
      "scan10",
      "scan1",
    ]);
    const starred = files.map((file) => ({
      ...file,
      isStarred: file.id === "scan1",
    }));
    expect(
      ids(sortQueueFiles(starred, documents, [], "newspaper", false)),
    ).toEqual(["scan1", "scan2", "scan10"]);
  });
  it("keeps manual order independent of other display sorts", () => {
    const order = ["scan2", "scan1", "scan10"];
    sortQueueFiles(files, documents, order, "name", true);
    expect(
      ids(sortQueueFiles(files, documents, order, "manual", false)),
    ).toEqual(order);
    expect(ids(files)).toEqual(["scan10", "scan2", "scan1"]);
  });
  it("groups filtered files by tag/year/paper, retaining order and repeated membership", () => {
    const tagged = groupQueueFiles(files, documents, "tag");
    expect(tagged.map((section) => [section.id, ids(section.files)])).toEqual([
      ["tag:甲", ["scan10"]],
      ["tag:乙", ["scan10", "scan2"]],
      ["tag:empty", ["scan1"]],
    ]);
    expect(
      groupQueueFiles([files[1]!], documents, "tag").map(
        (section) => section.id,
      ),
    ).toEqual(["tag:乙"]);
    expect(
      groupQueueFiles(files, documents, "year").map((section) => section.id),
    ).toEqual(["year:1935", "year:1936", "year:empty"]);
    expect(
      groupQueueFiles(
        [{ ...files[0]!, isStarred: true }],
        documents,
        "newspaper",
      ).map((section) => section.id),
    ).toEqual(["starred", "newspaper:申报"]);
  });
});
