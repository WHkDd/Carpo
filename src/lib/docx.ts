/**
 * Minimal .docx writer for the batch export — headings and plain paragraphs
 * only. OCR output that carries Markdown tables or LaTeX is written as its
 * source text; there is no table or equation conversion.
 *
 * A .docx is a ZIP of XML parts. The archive is written with the "stored"
 * method (no compression): Word reads it fine, and it keeps this file free of
 * a deflate dependency. Only the parts Word requires are emitted: content
 * types, the package relationship, the document, and a style sheet so the
 * headings show up in Word's navigation pane.
 */

export type DocBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "paragraph"; text: string };

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

/** Half-point sizes per heading level (16 / 14 / 13 / 12 pt). */
const HEADING_SIZES = [32, 28, 26, 24] as const;

function headingStyle(level: number): string {
  const size = HEADING_SIZES[level - 1];
  return `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${[1, 2, 3, 4].map(headingStyle).join("")}</w:styles>`;

/** Drops characters XML 1.0 forbids outright (C0 controls other than tab /
 *  LF / CR, lone surrogates, U+FFFE/FFFF). One of these in OCR output would
 *  make Word refuse the whole file. A code-point scan rather than a regex:
 *  the lone-surrogate case needs lookbehind, which older macOS WebViews
 *  cannot parse. */
function stripInvalidXml(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    if (c === 0xfffe || c === 0xffff) continue;
    // `for…of` yields paired surrogates as one code point, so anything left
    // in this range is unpaired.
    if (c >= 0xd800 && c <= 0xdfff) continue;
    out += ch;
  }
  return out;
}

function escapeXml(text: string): string {
  return stripInvalidXml(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function runs(text: string): string {
  // A tab inside <w:t> renders as a space; Word wants an explicit <w:tab/>.
  return text
    .split("\t")
    .map((part) => `<w:r><w:t xml:space="preserve">${escapeXml(part)}</w:t></w:r>`)
    .join("<w:r><w:tab/></w:r>");
}

function paragraphXml(block: DocBlock): string {
  // A lone CR (old Mac line ending) is a line break too.
  const text = block.text.replace(/\r\n|\r|\n/g, " ");
  if (block.kind === "heading") {
    return `<w:p><w:pPr><w:pStyle w:val="Heading${block.level}"/></w:pPr>${runs(text)}</w:p>`;
  }
  return `<w:p>${runs(text)}</w:p>`;
}

export function documentXml(blocks: DocBlock[]): string {
  // An empty body is legal, but Word shows a repair prompt for some
  // versions without at least one paragraph.
  const body = blocks.length > 0 ? blocks.map(paragraphXml).join("") : "<w:p/>";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

/** Splits OCR text into blocks: a Markdown ATX heading line becomes a
 *  heading `baseLevel` levels deeper than its `#` count suggests (clamped to
 *  4), every other non-empty line a paragraph. */
export function markdownToDocBlocks(text: string, baseLevel: number): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: clampLevel(baseLevel + heading[1]!.length),
        text: heading[2]!.trim(),
      });
    } else {
      blocks.push({ kind: "paragraph", text: line });
    }
  }
  return blocks;
}

export function clampLevel(level: number): 1 | 2 | 3 | 4 {
  return Math.min(4, Math.max(1, Math.floor(level))) as 1 | 2 | 3 | 4;
}

export function buildDocx(blocks: DocBlock[]): Uint8Array {
  return zipStored([
    ["[Content_Types].xml", CONTENT_TYPES],
    ["_rels/.rels", PACKAGE_RELS],
    ["word/_rels/document.xml.rels", DOCUMENT_RELS],
    ["word/document.xml", documentXml(blocks)],
    ["word/styles.xml", STYLES],
  ]);
}

// ---------------------------------------------------------------------------
// Stored (uncompressed) ZIP
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStored(entries: Array<[name: string, content: string]>): Uint8Array {
  const encoder = new TextEncoder();
  const now = new Date();
  const dosTime =
    (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate =
    ((Math.max(1980, now.getFullYear()) - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate();

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    // extra / comment / disk / internal attrs stay 0
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let pos = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
