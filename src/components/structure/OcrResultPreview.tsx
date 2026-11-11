import { memo, useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useT } from "@/i18n";
import {
  layoutCanvasMapping,
  scaleLayoutBBox,
  type LayoutPage,
} from "@/lib/layout-document";
import { encodeRegionAsJpegBase64 } from "@/lib/capture";

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
    hChildren?: HtmlNode[];
  };
}
interface HtmlNode {
  type: "element" | "text";
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
}

const SUPPORTED_TAGS = new Set([
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "colgroup",
  "col",
  "div",
  "p",
  "span",
  "br",
  "sup",
  "sub",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "img",
  "a",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
const DROP_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "svg",
  "math",
  "template",
  "link",
  "meta",
  "base",
]);

function safeImageSource(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Relative Paddle image names need an explicit mapping; they are not paths
  // relative to tauri://localhost and must not accidentally request app files.
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value))
    return value;
  try {
    const url = new URL(value);
    return ["https:", "http:", "blob:", "asset:"].includes(url.protocol)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Rebuild only supported tags and attributes, never inserting parsed HTML. */
function supportedHtml(node: Node): HtmlNode[] {
  if (node.nodeType === Node.TEXT_NODE)
    return [{ type: "text", value: node.textContent ?? "" }];
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (DROP_CONTENT.has(tag)) return [];
  const children = Array.from(node.childNodes)
    .flatMap(supportedHtml)
    .filter(
      (child) =>
        !["table", "thead", "tbody", "tfoot", "tr", "colgroup"].includes(tag) ||
        child.type !== "text" ||
        !!child.value?.trim(),
    );
  if (!SUPPORTED_TAGS.has(tag)) return children;
  const properties: Record<string, unknown> = {};
  const alignment =
    element.getAttribute("align")?.toLowerCase() ||
    (element as HTMLElement).style?.textAlign;
  if (["left", "center", "right"].includes(alignment ?? ""))
    properties.style = `text-align: ${alignment}`;
  if ((tag === "div" || tag === "p") && alignment === "center")
    properties.className = ["ocr-centered"];
  for (const [attribute, property] of [
    ["colspan", "colSpan"],
    ["rowspan", "rowSpan"],
    ["span", "span"],
  ]) {
    const raw = element.getAttribute(attribute!);
    if (raw && /^(?:td|th|col|colgroup)$/.test(tag)) {
      const number = Number(raw);
      if (Number.isFinite(number))
        properties[property!] = Math.max(1, Math.min(100, Math.floor(number)));
    }
  }
  if (tag === "img") {
    properties.src = element.getAttribute("src") ?? "";
    properties.alt = element.getAttribute("alt") ?? "";
  }
  if (tag === "a")
    properties.href = defaultUrlTransform(element.getAttribute("href") ?? "");
  return [{ type: "element", tagName: tag, properties, children }];
}

function inlineTag(
  node: MarkdownNode,
): { closing: boolean; name: string } | null {
  if (node.type !== "html") return null;
  const match = /^<\s*(\/?)\s*(sup|sub|span|strong|b|em|i|u|s|del)\s*>$/i.exec(
    node.value?.trim() ?? "",
  );
  return match ? { closing: !!match[1], name: match[2]!.toLowerCase() } : null;
}

/** Runs on Markdown's syntax tree so fenced/inline code stays literal. */
function paddleMarkup() {
  return function transform(tree: MarkdownNode) {
    function visit(node: MarkdownNode) {
      if (node.type === "inlineMath") {
        const script = /^\s*([\^_])\s*\{([^{}]*)\}\s*$/.exec(node.value ?? "");
        if (script) {
          node.type = "paddleInline";
          node.data = { hName: script[1] === "^" ? "sup" : "sub" };
          node.children = [{ type: "text", value: script[2] }];
          delete node.value;
        }
      }
      if (!node.children) return;
      const children = node.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        const opening = inlineTag(child);
        if (opening && !opening.closing) {
          let depth = 1;
          let end = i + 1;
          for (; end < children.length; end++) {
            const tag = inlineTag(children[end]!);
            if (tag?.name === opening.name) depth += tag.closing ? -1 : 1;
            if (depth === 0) break;
          }
          if (depth === 0) {
            const replacement: MarkdownNode = {
              type: "paddleInline",
              data: { hName: opening.name },
              children: children.slice(i + 1, end),
            };
            children.splice(i, end - i + 1, replacement);
            visit(replacement);
            continue;
          }
        }
        if (child.type === "html") {
          const parsed = new DOMParser().parseFromString(
            child.value ?? "",
            "text/html",
          );
          // Table fragments such as <tr> need a table parsing context.
          const html = Array.from(parsed.body.childNodes).flatMap(
            supportedHtml,
          );
          const inline =
            node.type !== "root" &&
            node.type !== "blockquote" &&
            node.type !== "listItem";
          children[i] = {
            type: inline ? "paddleInline" : "paragraph",
            data: { hName: inline ? "span" : "div", hChildren: html },
            children: [],
          };
        } else visit(child);
      }
    }
    visit(tree);
  };
}

function PreviewImage({ source, alt }: { source?: string; alt?: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  if (!source || failed)
    return (
      <span
        className="ocr-image-placeholder"
        role="img"
        aria-label={t("ocr.previewImageMissing")}
      >
        {alt || t("ocr.previewImageMissing")}
      </span>
    );
  return (
    <img
      src={source}
      alt={alt || t("ocr.previewImage")}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/** Paddle's limited HTML is rendered alongside ordinary Markdown and math. */
export const OcrResultPreview = memo(function OcrResultPreview({
  text,
  imageSources = {},
  layout,
  source,
}: {
  text: string;
  imageSources?: Record<string, string>;
  layout?: LayoutPage;
  source?: { objectUrl: string; width: number; height: number };
}) {
  const [crops, setCrops] = useState<{
    layout?: LayoutPage;
    url?: string;
    images: Record<string, string>;
  }>({ images: {} });
  useEffect(() => {
    const mapping = layoutCanvasMapping(layout, source);
    const blocks = layout?.blocks.filter((block) => block.imageRef) ?? [];
    if (!mapping || !source || !blocks.length) return;
    let cancelled = false;
    const capture = async () => {
      const response = await fetch(source.objectUrl);
      if (!response.ok) return;
      const blob = await response.blob();
      const images: Record<string, string> = {};
      for (const block of blocks) {
        if (cancelled) return;
        try {
          const encoded = await encodeRegionAsJpegBase64(
            blob,
            scaleLayoutBBox(block.bbox, mapping),
          );
          images[block.imageRef!] = `data:image/jpeg;base64,${encoded}`;
        } catch {
          /* A missing crop keeps the explicit placeholder. */
        }
      }
      if (!cancelled) setCrops({ layout, url: source.objectUrl, images });
    };
    void capture().catch(() => {
      /* The text remains readable if the page image was evicted. */
    });
    return () => {
      cancelled = true;
    };
  }, [layout, source]);
  const localImages =
    crops.layout === layout && crops.url === source?.objectUrl
      ? crops.images
      : {};
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, paddleMarkup]}
      rehypePlugins={[[rehypeKatex, { strict: true, trust: false }]]}
      urlTransform={(url, key) =>
        key === "src"
          ? (safeImageSource(localImages[url] ?? imageSources[url] ?? url) ??
            "")
          : defaultUrlTransform(url)
      }
      components={{
        img: ({ src, alt }) => (
          <PreviewImage key={src} source={safeImageSource(src)} alt={alt} />
        ),
      }}
      disallowedElements={[
        "script",
        "iframe",
        "object",
        "embed",
        "form",
        "input",
        "button",
      ]}
      unwrapDisallowed
    >
      {text}
    </ReactMarkdown>
  );
});
