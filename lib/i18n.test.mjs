import assert from "node:assert/strict";
import test from "node:test";
const { resolveNavigatorLocale } = await import("./i18n/index.tsx");

test("Chinese locale resolution distinguishes script and region variants without matching longer prefixes", () => {
  for (const [language, expected] of [
    ["zh-TW", "zh-TW"],
    ["ZH-hAnt-hK", "zh-TW"],
    ["zh-Hant-CN", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-Hans-TW", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-TWICE", "zh-CN"],
    ["ja-JP", "ja"],
    ["fr-FR", "en"],
    [null, "en"],
  ]) assert.equal(resolveNavigatorLocale(language), expected, String(language));
});
