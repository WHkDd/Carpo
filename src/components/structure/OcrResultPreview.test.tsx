// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeRegionAsJpegBase64 } from "@/lib/capture";
import { OcrResultPreview } from "./OcrResultPreview";
vi.mock("@/lib/capture", () => ({
  encodeRegionAsJpegBase64: vi.fn(async () => "/9j/2Q=="),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Paddle result preview", () => {
  it("renders HTML table spans, alignment, line breaks and entities", () => {
    const { container } = render(
      <OcrResultPreview
        text={
          '<table><tr><th colspan="2">统计&amp;资料</th></tr><tr><td rowspan="2">甲<br>乙</td><td style="text-align:right">12</td></tr><tr><td>13</td></tr></table>'
        }
      />,
    );
    expect(screen.getByRole("columnheader").getAttribute("colspan")).toBe("2");
    const cells = screen.getAllByRole("cell");
    expect(cells[0]!.getAttribute("rowspan")).toBe("2");
    expect(cells[0]!.querySelector("br")).not.toBeNull();
    expect(cells[1]!.style.textAlign).toBe("right");
    expect(container.textContent).toContain("统计&资料");
  });
  it("preserves Markdown, centered text, HTML scripts and Paddle math scripts", () => {
    const { container } = render(
      <OcrResultPreview
        text={
          '# 标题\n\n**正文** H<sub>2</sub>O 和 x<sup>2</sup>，$^{注}$、$_{下}$，$x^2+y^2$。\n\n<div style="text-align:center">居中文字</div>'
        }
      />,
    );
    expect(screen.getByRole("heading", { name: "标题" })).not.toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("正文");
    expect(
      Array.from(container.querySelectorAll("sup")).map(
        (node) => node.textContent,
      ),
    ).toContain("注");
    expect(
      Array.from(container.querySelectorAll("sub")).map(
        (node) => node.textContent,
      ),
    ).toContain("下");
    expect(container.querySelector(".ocr-centered")?.textContent).toBe(
      "居中文字",
    );
    expect(container.querySelector(".katex")).not.toBeNull();
  });
  it("keeps markup inside code literal and strips executable HTML/attributes", () => {
    const { container } = render(
      <OcrResultPreview
        text={
          '`<sup>literal</sup>`\n\n```html\n<table><tr><td>code</td></tr></table>\n```\n\n<div onclick="alert(1)">safe<script>alert(2)</script><iframe src="https://example.com"></iframe><img src="javascript:alert(3)" onerror="alert(4)"></div>'
        }
      />,
    );
    expect(container.querySelector("code")?.textContent).toBe(
      "<sup>literal</sup>",
    );
    expect(container.querySelector("pre code")?.textContent).toContain(
      "<table>",
    );
    expect(
      container.querySelector("script,iframe,[onclick],[onerror]"),
    ).toBeNull();
    expect(container.textContent).toContain("safe");
    expect(container.textContent).not.toContain("alert(2)");
    expect(container.querySelector('img[src^="javascript:"]')).toBeNull();
  });
  it("resolves supplied image names and shows a placeholder for missing or failed images", () => {
    render(
      <OcrResultPreview
        text={
          '<img src="imgs/figure.jpg" alt="原图">\n\n![缺图](imgs/missing.jpg)'
        }
        imageSources={{ "imgs/figure.jpg": "https://example.com/figure.jpg" }}
      />,
    );
    const picture = screen.getByRole("img", { name: "原图" });
    expect(picture.getAttribute("src")).toBe("https://example.com/figure.jpg");
    expect(picture.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getByText("缺图")).not.toBeNull();
    fireEvent.error(picture);
    expect(screen.getByText("原图")).not.toBeNull();
  });
  it("uses the current page's measured crop for a relative Paddle image name", async () => {
    const blob = new Blob(["page"]);
    const fetch = vi.fn(async () => ({ ok: true, blob: async () => blob }));
    vi.stubGlobal("fetch", fetch);
    render(
      <OcrResultPreview
        text={'<img src="imgs/figure.jpg" alt="原页图片">'}
        layout={{
          index: 1,
          width: 1000,
          height: 1400,
          blocks: [
            {
              label: "image",
              text: "",
              bbox: [100, 200, 500, 600],
              imageRef: "imgs/figure.jpg",
            },
          ],
        }}
        source={{ objectUrl: "blob:original-page", width: 500, height: 700 }}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "原页图片" }).getAttribute("src"),
      ).toBe("data:image/jpeg;base64,/9j/2Q=="),
    );
    expect(fetch).toHaveBeenCalledWith("blob:original-page");
    expect(encodeRegionAsJpegBase64).toHaveBeenCalledWith(blob, {
      x: 50,
      y: 100,
      width: 200,
      height: 200,
    });
  });
});
