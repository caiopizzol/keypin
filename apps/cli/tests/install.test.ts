import { describe, expect, test } from "vite-plus/test";
import { INSTALL, installProblem } from "../src/install";

function moduleNotFound(message: string): Error {
  return Object.assign(new Error(message), { code: "ERR_MODULE_NOT_FOUND" });
}

describe("installProblem", () => {
  test("a missing package names it, the install command and the repo", () => {
    const error = moduleNotFound(
      "Cannot find package '@keypin/destination-cloudflare' imported from /repo/apps/cli/src/start.ts",
    );
    expect(installProblem(error, "/repo")).toBe(
      `the package @keypin/destination-cloudflare isn't installed; run "${INSTALL}" in /repo`,
    );
  });

  test("Bun's real error for a missing package is recognized", async () => {
    const missing: string = "@keypin/no-such-package";
    const error = await import(missing).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(installProblem(error, "/repo")).toContain(
      "the package @keypin/no-such-package isn't installed",
    );
  });

  test("the default repo is this checkout", () => {
    const hint = installProblem(moduleNotFound("Cannot find package 'x'"));
    expect(hint).toMatch(/ in \/.+[^/]$/);
    expect(hint).not.toContain("/apps/cli");
  });

  test("any other error is left alone", () => {
    expect(installProblem(new Error("Cannot find package 'x'"))).toBeNull();
    expect(installProblem("ERR_MODULE_NOT_FOUND")).toBeNull();
  });
});
