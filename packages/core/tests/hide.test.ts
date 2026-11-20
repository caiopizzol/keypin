import { expect, test } from "vite-plus/test";
import { hideSecrets } from "../src/index";

test("hides a secret and its JSON-escaped form", () => {
  const secret = 'say "hi"\nnow';
  const escaped = JSON.stringify(secret).slice(1, -1);
  expect(hideSecrets(`raw ${secret} escaped ${escaped}`, [secret])).toBe(
    "raw [hidden] escaped [hidden]",
  );
});

test("a secret that reads like the marker is hidden once", () => {
  expect(hideSecrets("value hidden", ["hidden"])).toBe("value [hidden]");
});

test("overlapping matches leave no part of either secret visible", () => {
  expect(hideSecrets("xxabcdefyy", ["abcd", "cdef"])).toBe("xx[hidden]yy");
  const secret = 'a"b';
  const escaped = JSON.stringify(secret).slice(1, -1);
  expect(hideSecrets(`pre ${escaped}`, [secret, "pre a"])).toBe("[hidden]");
});

test("ignores empty and non-string entries", () => {
  expect(hideSecrets("nothing here", ["", undefined, null, 3])).toBe("nothing here");
});

test("hiding dense matches keeps no per-match objects on the JS heap", () => {
  const text = "ab".repeat(512 * 1024);
  const before = process.memoryUsage().heapUsed;
  const shown = hideSecrets(text, ["ab", "ba"]);
  const heapGrowth = process.memoryUsage().heapUsed - before;
  expect(shown).toBe("[hidden]");
  expect(heapGrowth).toBeLessThan(16 * 1024 * 1024);
});
