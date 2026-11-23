import { describe, expect, test } from "vite-plus/test";
import { cli, USAGE } from "../src/cli";
import { fakeDeps } from "./fakes";

const MORE = "keypin --help lists every command.\n";

describe("an unknown command", () => {
  test("suggests the one command a typo is close to", async () => {
    const typos: [string, string][] = [
      ["pubish", "publish"],
      ["chek", "check"],
      ["stauts", "status"],
      ["unregistr", "unregister"],
      ["pub", "publish"],
      ["rotat", "rotate"],
    ];
    for (const [typed, meant] of typos) {
      const { deps, stdout, stderr } = fakeDeps();
      expect(await cli([typed, "STRIPE_KEY"], deps)).toBe(2);
      expect(stderr.text).toBe(
        `keypin: unknown command "${typed}". Did you mean ${meant}?\n${MORE}`,
      );
      expect(stdout.text).toBe("");
    }
  });

  test("suggests nothing for a word no command is close to", async () => {
    for (const typed of ["deploy", "foo", "list", "up", "rm", "i", "init", "import", "run"]) {
      const { deps, stderr } = fakeDeps();
      expect(await cli([typed], deps)).toBe(2);
      expect(stderr.text).toBe(`keypin: unknown command "${typed}".\n${MORE}`);
    }
  });
});

describe("a usage error", () => {
  test("prints that command's usage, not every command's", async () => {
    const { deps, stdout, stderr } = fakeDeps();
    expect(await cli(["status", "--bogus"], deps)).toBe(2);
    const [error, ...rest] = stderr.text.split("\n");
    expect(error).toMatch(/^keypin status: Unknown option '--bogus'/);
    const own = USAGE.slice(
      USAGE.indexOf("  keypin status "),
      USAGE.indexOf("  keypin unregister "),
    );
    expect(own.split("\n").filter((line) => line.startsWith("  keypin "))).toHaveLength(2);
    expect(rest.join("\n")).toBe(own + MORE);
    expect(stdout.text).toBe("");
  });

  test("lists every form of a command with more than one", async () => {
    const { deps, stderr } = fakeDeps();
    expect(await cli(["publish", "A", "B"], deps)).toBe(2);
    expect(stderr.text).toMatch(/^keypin publish: keypin publish takes one key/);
    expect(stderr.text).toContain("  keypin publish <VARIABLE> ");
    expect(stderr.text).toContain("  keypin publish --all ");
    expect(stderr.text).not.toContain("keypin rotate");
    expect(stderr.text).not.toContain("Exit codes:");
    expect(stderr.text.endsWith(MORE)).toBe(true);
  });
});

describe("the full usage", () => {
  test("bare keypin prints it to stderr and exits 2", async () => {
    const { deps, stdout, stderr } = fakeDeps();
    expect(await cli([], deps)).toBe(2);
    expect(stderr.text).toBe(USAGE);
    expect(stdout.text).toBe("");
  });

  test("--help and -h print it to stdout and exit 0", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const { deps, stdout, stderr } = fakeDeps();
      expect(await cli([flag], deps)).toBe(0);
      expect(stdout.text).toBe(USAGE);
      expect(stderr.text).toBe("");
    }
  });

  test("names every command", () => {
    for (const command of ["check", "publish", "rotate", "status", "unregister"]) {
      expect(USAGE).toContain(`  keypin ${command} `);
    }
    expect(USAGE).toContain("  keypin --version ");
  });
});
