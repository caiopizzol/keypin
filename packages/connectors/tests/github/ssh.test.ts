import { describe, expect, test } from "vite-plus/test";
import { isSshName } from "../../src/github/ssh";

describe("isSshName", () => {
  test("accepts host aliases and users, nothing a shell or ssh would read as more", () => {
    for (const name of ["github-work", "github.com", "my_host.2", "git"])
      expect(isSshName(name)).toBe(true);
    for (const name of [
      "",
      "-oProxyCommand=x",
      "a;touch pwned",
      "$(touch pwned)",
      "`id`",
      "a b",
      "a|b",
      "a'b",
      "a%hb",
      "x".repeat(254),
    ])
      expect(isSshName(name)).toBe(false);
  });
});
