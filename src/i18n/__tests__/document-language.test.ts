// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "@/i18n";

afterEach(() => setLanguage("zh"));

describe("document language", () => {
  it("tracks runtime language changes for assistive technology", () => {
    setLanguage("en");
    expect(document.documentElement.lang).toBe("en");

    setLanguage("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});
