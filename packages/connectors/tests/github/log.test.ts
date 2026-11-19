import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { maskCommands, maskInLog } from "../../src/github/log";

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

describe("maskInLog", () => {
  const LOG = fileURLToPath(new URL("../../src/github/log.ts", import.meta.url));
  const MASK = "::add-mask::sk-one\n";
  const CHILD = `import { maskInLog } from ${JSON.stringify(LOG)};
await maskInLog(process.env, ["sk-one"], [process.stdout, process.stderr]);
process.stdout.write("out\\n");
process.stderr.write("err\\n");`;
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keypin-mask-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function masks(
    stdio: ("pipe" | "file")[],
    env: Record<string, string> = { GITHUB_ACTIONS: "true" },
  ) {
    const path = join(dir, "redirected");
    const file = openSync(path, "w");
    try {
      const fds = stdio.map((s) => (s === "file" ? file : "pipe"));
      const child = spawnSync(process.execPath, ["-e", CHILD], {
        env: { PATH: process.env.PATH, ...env },
        stdio: ["ignore", ...fds],
      });
      expect(child.status).toBe(0);
      return {
        stdout: String(child.stdout ?? ""),
        stderr: String(child.stderr ?? ""),
        file: readFileSync(path, "utf8"),
      };
    } finally {
      closeSync(file);
    }
  }

  test("writes the masks on each stream the runner reads, before the command's output", () => {
    expect(masks(["pipe", "pipe"])).toEqual({
      stdout: `${MASK}out\n`,
      stderr: `${MASK}err\n`,
      file: "",
    });
  });

  test("writes no masks on a stream redirected to a file", () => {
    expect(masks(["file", "pipe"])).toEqual({ stdout: "", stderr: `${MASK}err\n`, file: "out\n" });
    expect(masks(["pipe", "file"])).toEqual({ stdout: `${MASK}out\n`, stderr: "", file: "err\n" });
  });

  test("writes the masks on a shell pipe", () => {
    const child = spawnSync("sh", ["-c", '"$0" -e "$1" 2>&1 | cat', process.execPath, CHILD], {
      env: { PATH: process.env.PATH, GITHUB_ACTIONS: "true" },
    });
    expect(String(child.stdout)).toBe(`${MASK}${MASK}out\nerr\n`);
  });

  test("writes nothing to a terminal or other device", async () => {
    const device = openSync("/dev/null", "w");
    const written: string[] = [];
    const write = (chunk: string, done: () => void) => (written.push(chunk), done(), true);
    try {
      await maskInLog({ GITHUB_ACTIONS: "true" }, ["sk-one"], [{ fd: device, write }]);
    } finally {
      closeSync(device);
    }
    expect(written).toEqual([]);
  });

  test("writes nothing outside GitHub Actions", () => {
    expect(masks(["pipe", "pipe"], {})).toEqual({ stdout: "out\n", stderr: "err\n", file: "" });
  });
});
