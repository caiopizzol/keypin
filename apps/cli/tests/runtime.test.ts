import { describe, expect, test } from "vite-plus/test";
import { MIN_BUN, runtimeProblem } from "../src/runtime";

describe("runtimeProblem", () => {
  test("Node is refused before any Bun API is touched", () => {
    expect(runtimeProblem(undefined, "/bin/keypin")).toBe(
      `keypin runs on Bun ${MIN_BUN} or newer, not Node.`,
    );
  });

  test("an older Bun names the script that was run", () => {
    expect(runtimeProblem("1.3.12", "/usr/local/bin/keypin")).toContain(
      `run it with "bunx bun@${MIN_BUN} /usr/local/bin/keypin"`,
    );
  });

  test("the minimum and anything newer pass", () => {
    expect(runtimeProblem(MIN_BUN, "keypin")).toBeNull();
    expect(runtimeProblem("1.10.0", "keypin")).toBeNull();
  });
});
