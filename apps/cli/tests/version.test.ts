import { describe, expect, test } from "vite-plus/test";
import root from "../../../package.json";
import { cli, USAGE } from "../src/cli";
import { NEEDS_APPROVAL } from "../src/publishing";
import { fakeDeps } from "./fakes";

describe("keypin --version", () => {
  test("prints the root package version", async () => {
    for (const flag of ["--version", "-v"]) {
      const { deps, stdout, stderr } = fakeDeps();
      expect(await cli([flag], deps)).toBe(0);
      expect(stdout.text).toBe(`${root.version}\n`);
      expect(stderr.text).toBe("");
    }
  });
});

describe("exit codes", () => {
  test("a usage error and a stop for approval have different codes, both in the help", async () => {
    const { deps } = fakeDeps();
    expect(await cli(["no-such-command"], deps)).toBe(2);
    expect(NEEDS_APPROVAL).toBe(3);
    expect(USAGE).toContain("  2  usage error\n");
    expect(USAGE).toContain(`  ${NEEDS_APPROVAL}  stopped for approval`);
  });
});
