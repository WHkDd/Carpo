import { afterEach, describe, expect, it } from "vitest";
import {  setLanguage } from "@/i18n";
import { en, zh } from "@/i18n/messages";

// The suite-wide setup pins Chinese; every case here restores it so the
// other suites keep asserting on the Chinese wording.
afterEach(() => setLanguage("zh"));

describe("i18n", () => {
  it("keeps both catalogs on the same key set", () => {
    // `en` is typed as Record<MessageKey, string>, so a *missing* key is a
    // compile error. This catches the other direction: a stale English key
    // left behind after the Chinese one was renamed.
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it("keeps placeholder sets in step between the two catalogs", () => {
    const placeholders = (template: string) =>
      (template.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]));
    }
  });
});
