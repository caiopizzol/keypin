import { describe, expect, test } from "vite-plus/test";
import { maskCommands } from "../../src/github/log";

const ACTIONS = { GITHUB_ACTIONS: "true" };
const commands = (values: string[]) => maskCommands(ACTIONS, values).split("\n").slice(0, -1);

describe("maskCommands", () => {
  test("in GitHub Actions, registers each value", () => {
    expect(maskCommands(ACTIONS, ["sk-one"])).toBe("::add-mask::sk-one\n");
    expect(commands(["sk-one", "sk-two"])).toEqual(["::add-mask::sk-one", "::add-mask::sk-two"]);
  });

  test("registers each line of a multi-line value, skipping blank and repeated lines", () => {
    const pem = "-----BEGIN KEY-----\nAAAA\r\n\n  BBBB  \r\n \rAAAA\n-----END KEY-----\n";
    expect(commands([pem])).toEqual([
      "::add-mask::-----BEGIN KEY-----",
      "::add-mask::AAAA",
      "::add-mask::BBBB",
      "::add-mask::-----END KEY-----",
    ]);
  });

  test("escapes % so the runner unescapes the value it was given", () => {
    expect(maskCommands(ACTIONS, ["a%0Ab%25c%"])).toBe("::add-mask::a%250Ab%2525c%25\n");
  });

  test("writes nothing outside GitHub Actions, or for nothing to hide", () => {
    for (const env of [{}, { GITHUB_ACTIONS: "false" }, { GITLAB_CI: "true" }])
      expect(maskCommands(env, ["sk-one"])).toBe("");
    expect(maskCommands(ACTIONS, ["", " \n\t"])).toBe("");
  });
});
