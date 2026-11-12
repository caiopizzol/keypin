import { describe, expect, test } from "vite-plus/test";
import {
  hostTarget,
  type Launcher,
  launchedBinary,
  LAUNCHER_MAX_BYTES,
  launcherHash,
  platformPackage,
  type Target,
  TARGETS,
} from "../src/layout";

const LAUNCHER = "#!/bin/sh\nexec keypin\n";
const BIN = "/g/lib/node_modules/keypin/bin/keypin";
const FLAT = "/g/lib/node_modules/@keypin/cli-linux-x64/bin/keypin";
const NESTED = "/g/lib/node_modules/keypin/node_modules/@keypin/cli-linux-x64/bin/keypin";

function launcher(
  files: Record<string, string>,
  target: Target = "linux-x64",
): Launcher & { reads: string[] } {
  const reads: string[] = [];
  return {
    hash: launcherHash(LAUNCHER),
    target,
    reads,
    size: (path) => files[path]?.length ?? null,
    read: (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
    exists: (path) => path in files,
  };
}

const MAC = (cpu: string) => `/g/lib/node_modules/@keypin/cli-darwin-${cpu}/bin/keypin`;

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

  test("with no platform package next to it, the file on PATH is never read", () => {
    const found = launcher({ [BIN]: LAUNCHER });
    expect(launchedBinary(BIN, found)).toBe(null);
    expect(found.reads).toEqual([]);
  });

  test("a file larger than any launcher, such as a compiled keypin, is never read", () => {
    const big = launcher({ [BIN]: "x".repeat(LAUNCHER_MAX_BYTES + 1), [FLAT]: "" });
    expect(launchedBinary(BIN, big)).toBe(null);
    expect(big.reads).toEqual([]);
  });

  test("on macOS, the other architecture's package counts, as the launcher falls back to it", () => {
    expect(
      launchedBinary(BIN, launcher({ [BIN]: LAUNCHER, [MAC("x64")]: "" }, "darwin-arm64")),
    ).toBe(MAC("x64"));
    expect(
      launchedBinary(
        BIN,
        launcher({ [BIN]: LAUNCHER, [MAC("x64")]: "", [MAC("arm64")]: "" }, "darwin-arm64"),
      ),
    ).toBe(MAC("arm64"));
    expect(
      launchedBinary(BIN, launcher({ [BIN]: LAUNCHER, [MAC("arm64")]: "" }, "darwin-x64")),
    ).toBe(MAC("arm64"));
  });

  test("on Linux, only this architecture's package counts", () => {
    const arm = "/g/lib/node_modules/@keypin/cli-linux-arm64/bin/keypin";
    expect(launchedBinary(BIN, launcher({ [BIN]: LAUNCHER, [arm]: "" }))).toBe(null);
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
