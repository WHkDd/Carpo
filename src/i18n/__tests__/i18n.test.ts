import { describe, expect, it } from "vitest";
import { en, zh } from "@/i18n/messages";

describe("i18n", () => {
  it("keeps placeholder sets in step between the two catalogs", () => {
    const placeholders = (template: string) =>
      (template.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]));
    }
  });
});
