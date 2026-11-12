import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { type Here, selfFor, terminalPath } from "../src/self";

const FULL = ["/opt/homebrew/Cellar/bun/1.4.4/bin/bun", "--no-env-file", "/lib/keypin/main.js"];

function here(over: Partial<Here> & { links?: Record<string, string> } = {}): Here {
  const links: Record<string, string> = {
    "/home/me/.bun/bin/keypin": "/lib/keypin/main.js",
    "/lib/keypin/main.js": "/lib/keypin/main.js",
    "/tmp/project": "/private/tmp/project",
    "/private/tmp/project": "/private/tmp/project",
    ...over.links,
  };
  return {
    full: FULL,
    running: ["/lib/keypin/main.js"],
    cwd: "/private/tmp/project",
    env: { PATH: "/home/me/.bun/bin:/usr/bin", PWD: "/tmp/project" },
    which: (name, path) =>
      path.split(":").includes("/home/me/.bun/bin") ? `/home/me/.bun/bin/${name}` : null,
    real: (path) => links[path] ?? null,
    launches: () => null,
    ...over,
  };
}

describe("selfFor", () => {
  test("the keypin on PATH is this keypin: keypin, in the folder the user typed", () => {
    expect(selfFor(here())).toEqual({ folder: "/tmp/project", command: ["keypin"] });
  });

  test("another keypin on PATH: the full command", () => {
    const self = selfFor(here({ links: { "/home/me/.bun/bin/keypin": "/old/keypin/main.js" } }));
    expect(self.command).toEqual(FULL);
  });

  test("no keypin on PATH: the full command", () => {
    expect(selfFor(here({ which: () => null })).command).toEqual(FULL);
  });

  test("a keypin on PATH that no longer resolves: the full command", () => {
    expect(selfFor(here({ real: () => null })).command).toEqual(FULL);
  });

  test("a relative running path never counts as this keypin", () => {
    expect(selfFor(here({ running: ["main.js"] })).command).toEqual(FULL);
  });

  test("a keypin that only a runner's node_modules/.bin put on PATH: the full command", () => {
    const self = selfFor(
      here({
        env: { PATH: "/cache/.bunx-501/keypin@0.7.0/node_modules/.bin:/usr/bin" },
        which: (name, path) =>
          path.includes("node_modules/.bin") ? `/cache/node_modules/.bin/${name}` : null,
        links: { "/cache/node_modules/.bin/keypin": "/lib/keypin/main.js" },
      }),
    );
    expect(self.command).toEqual(FULL);
  });

  test("the keypin on PATH is the npm launcher that runs this binary: keypin", () => {
    const binary = "/g/lib/node_modules/@keypin/cli-darwin-arm64/bin/keypin";
    const self = selfFor(
      here({
        full: [binary],
        running: [binary],
        links: {
          "/home/me/.bun/bin/keypin": "/g/lib/node_modules/keypin/bin/keypin",
          [binary]: binary,
        },
        launches: (path) => (path === "/g/lib/node_modules/keypin/bin/keypin" ? binary : null),
      }),
    );
    expect(self.command).toEqual(["keypin"]);
  });

  test("an npm launcher that runs another binary: the full command", () => {
    const binary = "/g/lib/node_modules/@keypin/cli-darwin-arm64/bin/keypin";
    const self = selfFor(
      here({
        full: ["/tmp/keypin"],
        running: ["/tmp/keypin"],
        links: {
          "/home/me/.bun/bin/keypin": "/g/lib/node_modules/keypin/bin/keypin",
          [binary]: binary,
          "/tmp/keypin": "/tmp/keypin",
        },
        launches: () => binary,
      }),
    );
    expect(self.command).toEqual(["/tmp/keypin"]);
  });

  test("a PWD that isn't this folder, or that is missing, leaves the real folder", () => {
    expect(selfFor(here({ env: { PWD: "/somewhere/else" } })).folder).toBe("/private/tmp/project");
    expect(selfFor(here({ env: {} })).folder).toBe("/private/tmp/project");
    expect(selfFor(here({ env: { PWD: "tmp/project" } })).folder).toBe("/private/tmp/project");
  });
});

describe("terminalPath", () => {
  test("drops the node_modules/.bin folders a runner adds, and relative entries", () => {
    expect(
      terminalPath("/a/node_modules/.bin:bin:/usr/local/bin:/b/node_modules/.bin/:/usr/bin"),
    ).toBe("/usr/local/bin:/usr/bin");
    expect(terminalPath(undefined)).toBe("");
  });
});

describe("selfFor on disk", () => {
  let root = "";
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "keypin-self-")));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function onDisk() {
    await mkdir(join(root, "lib"), { recursive: true });
    await mkdir(join(root, "bin"));
    await mkdir(join(root, "project"));
    await writeFile(join(root, "lib/main.js"), "");
    await chmod(join(root, "lib/main.js"), 0o755);
    await symlink(join(root, "lib/main.js"), join(root, "bin/keypin"));
    await symlink(join(root, "project"), join(root, "link"));
    const real = (path: string) => {
      try {
        return realpathSync(path);
      } catch {
        return null;
      }
    };
    return {
      full: FULL,
      running: [join(root, "lib/main.js")],
      cwd: join(root, "project"),
      env: { PATH: `${join(root, "bin")}:/usr/bin`, PWD: join(root, "link") },
      which: (name: string, path: string) => Bun.which(name, { PATH: path }),
      real,
      launches: () => null,
    };
  }

  test("a symlinked bin and a symlinked folder resolve to keypin in the typed folder", async () => {
    const disk = await onDisk();
    expect(selfFor(disk)).toEqual({ folder: join(root, "link"), command: ["keypin"] });
  });

  test("a bin pointing at another copy prints the full command", async () => {
    const disk = await onDisk();
    await writeFile(join(root, "lib/other.js"), "");
    expect(selfFor({ ...disk, running: [join(root, "lib/other.js")] }).command).toEqual(FULL);
  });

  test("a relative PATH entry before it that finds another keypin prints the full command", async () => {
    const disk = await onDisk();
    await mkdir(join(root, "project/bin"));
    await writeFile(join(root, "project/bin/keypin"), "");
    await chmod(join(root, "project/bin/keypin"), 0o755);
    const shadowed = { ...disk, env: { ...disk.env, PATH: `bin:${join(root, "bin")}:/usr/bin` } };
    expect(selfFor(shadowed).command).toEqual(FULL);
  });

  test("a node_modules/.bin entry before it that finds another keypin prints the full command", async () => {
    const disk = await onDisk();
    const local = join(root, "project/node_modules/.bin");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "keypin"), "");
    await chmod(join(local, "keypin"), 0o755);
    const shadowed = {
      ...disk,
      env: { ...disk.env, PATH: `${local}:${join(root, "bin")}:/usr/bin` },
    };
    expect(selfFor(shadowed).command).toEqual(FULL);
  });

  test("a relative PATH entry with no keypin in it leaves keypin", async () => {
    const disk = await onDisk();
    const clear = { ...disk, env: { ...disk.env, PATH: `bin:${join(root, "bin")}:/usr/bin` } };
    expect(selfFor(clear).command).toEqual(["keypin"]);
  });
});
