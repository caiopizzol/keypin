import { describe, expect, test } from "vite-plus/test";
import {
  hostTarget,
  type Launcher,
  launchedBinary,
  launcherHash,
  platformPackage,
  TARGETS,
} from "../src/layout";

const LAUNCHER = "#!/bin/sh\nexec keypin\n";
const BIN = "/g/lib/node_modules/keypin/bin/keypin";
const FLAT = "/g/lib/node_modules/@keypin/cli-linux-x64/bin/keypin";
const NESTED = "/g/lib/node_modules/keypin/node_modules/@keypin/cli-linux-x64/bin/keypin";

function launcher(files: Record<string, string>): Launcher {
  return {
    hash: launcherHash(LAUNCHER),
    target: "linux-x64",
    read: (path) => files[path] ?? null,
    exists: (path) => path in files,
  };
}

describe("hostTarget", () => {
  test("the four platforms keypin ships, and nothing else", () => {
    expect(hostTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostTarget("linux", "x64")).toBe("linux-x64");
    expect(hostTarget("win32", "x64")).toBeNull();
    expect(hostTarget("linux", "ia32")).toBeNull();
  });
});

describe("launchedBinary", () => {
  test("a flat install: the platform package next to keypin", () => {
    expect(launchedBinary(BIN, launcher({ [BIN]: LAUNCHER, [FLAT]: "" }))).toBe(FLAT);
  });

  test("a nested install comes first, the order the launcher looks in", () => {
    expect(launchedBinary(BIN, launcher({ [BIN]: LAUNCHER, [FLAT]: "", [NESTED]: "" }))).toBe(
      NESTED,
    );
  });

  test("a file that isn't keypin's launcher launches nothing, even next to a binary", () => {
    expect(launchedBinary(BIN, launcher({ [BIN]: "#!/bin/sh\necho other\n", [FLAT]: "" }))).toBe(
      null,
    );
    expect(launchedBinary(BIN, launcher({ [FLAT]: "" }))).toBe(null);
  });

  test("the launcher with no platform package launches nothing", () => {
    expect(launchedBinary(BIN, launcher({ [BIN]: LAUNCHER }))).toBe(null);
  });

  test("every target has its own package", () => {
    expect(TARGETS.map(platformPackage)).toEqual([
      "@keypin/cli-darwin-arm64",
      "@keypin/cli-darwin-x64",
      "@keypin/cli-linux-x64",
      "@keypin/cli-linux-arm64",
    ]);
  });
});
