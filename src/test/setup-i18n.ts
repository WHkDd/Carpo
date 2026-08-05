import { setLanguage } from "@/i18n";

// Pin the message catalog for the whole suite. Without this the language is
// probed from `navigator.language`, which is `en-US` under jsdom — assertions
// on user-facing strings would then depend on the environment rather than on
// the code under test.
setLanguage("zh");
