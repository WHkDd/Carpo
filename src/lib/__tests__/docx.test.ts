// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildDocx, crc32, documentXml, markdownToDocBlocks } from "../docx";

/** Walks the local file headers of a stored ZIP. Deliberately independent of
 *  the writer: it trusts only the format, so a wrong offset or size in the
 *  writer shows up as a garbled entry here. */
function readStoredZip(bytes: Uint8Array): Map<string, { data: Uint8Array; crc: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, { data: Uint8Array; crc: number }>();
  let pos = 0;
  while (view.getUint32(pos, true) === 0x04034b50) {
    expect(view.getUint16(pos + 8, true)).toBe(0); // stored
    const crc = view.getUint32(pos + 14, true);
    const size = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
    const start = pos + 30 + nameLen + extraLen;
    out.set(name, { data: bytes.subarray(start, start + size), crc });
    pos = start + size;
  }
  // Central directory follows, then the end record pointing back at it.
  const endPos = bytes.length - 22;
  expect(view.getUint32(endPos, true)).toBe(0x06054b50);
  expect(view.getUint16(endPos + 10, true)).toBe(out.size);
  expect(view.getUint32(endPos + 16, true)).toBe(pos);
  return out;
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("buildDocx", () => {
  const bytes = buildDocx([
    { kind: "heading", level: 1, text: "申報 第一版" },
    { kind: "paragraph", text: "a < b & c\u0001 結束\t後" },
  ]);
  const entries = readStoredZip(bytes);

  it("contains the parts Word requires, each with a correct CRC", () => {
    expect([...entries.keys()].sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/_rels/document.xml.rels",
      "word/document.xml",
      "word/styles.xml",
    ]);
    for (const { data, crc } of entries.values()) {
      expect(crc32(data)).toBe(crc);
    }
  });

  it("writes well-formed XML with escaped text and headings", () => {
    const decode = (name: string) =>
      new TextDecoder().decode(entries.get(name)!.data);
    for (const name of entries.keys()) {
      const doc = new DOMParser().parseFromString(decode(name), "application/xml");
      expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    }
    const xml = decode("word/document.xml");
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain("申報 第一版");
    expect(xml).toContain("a &lt; b &amp; c 結束");
    expect(xml).not.toContain("\u0001");
    expect(xml).toContain("<w:tab/>");
    expect(decode("word/styles.xml")).toContain('w:styleId="Heading1"');
  });
});

describe("line endings", () => {
  it("treats a lone CR as a line break", () => {
    expect(markdownToDocBlocks("一\r二\r\n三", 1)).toEqual([
      { kind: "paragraph", text: "一" },
      { kind: "paragraph", text: "二" },
      { kind: "paragraph", text: "三" },
    ]);
    expect(documentXml([{ kind: "paragraph", text: "甲\r乙" }])).toContain(
      '<w:t xml:space="preserve">甲 乙</w:t>'
    );
  });
});

describe("markdownToDocBlocks", () => {
  it("maps ATX headings below the base level and drops blank lines", () => {
    expect(markdownToDocBlocks("## 小標\n\n正文一\n正文二\n###### 深", 1)).toEqual([
      { kind: "heading", level: 3, text: "小標" },
      { kind: "paragraph", text: "正文一" },
      { kind: "paragraph", text: "正文二" },
      { kind: "heading", level: 4, text: "深" },
    ]);
  });
});
