import { describe, expect, it } from "vitest";
import { partitionBySupportedExtension } from "./useFileImport";

describe("partitionBySupportedExtension", () => {
  it("partitions paths case-insensitively and rejects missing extensions", () => {
    const paths = ["/tmp/scan.PDF", "/tmp/photo.png", "/tmp/notes.docx", "/tmp/README"];
    const result = partitionBySupportedExtension(paths, (path) => path, ["pdf", "png"]);

    expect(result.accepted).toEqual(["/tmp/scan.PDF", "/tmp/photo.png"]);
    expect(result.rejected).toEqual(["/tmp/notes.docx", "/tmp/README"]);
  });
});
