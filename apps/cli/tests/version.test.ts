import { describe, expect, test } from "vite-plus/test";
import root from "../../../package.json";
import { cli } from "../src/cli";
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
