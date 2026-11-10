import { describe, expect, test } from "vite-plus/test";
import { loadRegistry } from "@keypin/core";
import { cli } from "../src/cli";
import { fakeDeps, memoryFiles, REGISTRY, registryWith } from "./fakes";

function registered(...projects: string[]) {
  return memoryFiles({
    [REGISTRY]: registryWith(...projects),
    "/work/billing/keypin.toml": "# mine\n",
  });
}

describe("keypin unregister", () => {
  test("removes the current folder and leaves its keypin.toml", async () => {
    const disk = registered("/work/billing", "/work/web");
    const { deps, stderr } = fakeDeps({ disk });
    expect(await cli(["unregister"], deps)).toBe(0);
    expect((await loadRegistry(disk.files, REGISTRY)).projects).toEqual(["/work/web"]);
    expect(disk.contents.get("/work/billing/keypin.toml")).toBe("# mine\n");
    expect(stderr.text).toBe(
      `keypin: /work/billing is no longer registered (1 project in ${REGISTRY})\n`,
    );
  });

  test("removes a folder given as an argument, even one that no longer exists", async () => {
    const disk = registered("/work/billing", "/tmp/removed-worktree/app");
    const { deps } = fakeDeps({ disk, deps: { cwd: "/tmp" } });
    expect(await cli(["unregister", "removed-worktree/app/"], deps)).toBe(0);
    expect((await loadRegistry(disk.files, REGISTRY)).projects).toEqual(["/work/billing"]);
  });

  test("a folder that isn't registered changes nothing, exits 1 and lists the registered ones", async () => {
    const disk = registered("/work/billing");
    const before = disk.contents.get(REGISTRY);
    const { deps, stderr } = fakeDeps({ disk, deps: { cwd: "/work/web" } });
    expect(await cli(["unregister"], deps)).toBe(1);
    expect(disk.contents.get(REGISTRY)).toBe(before);
    expect(stderr.text).toBe(
      `keypin: /work/web wasn't registered (1 project in ${REGISTRY})\n  /work/billing\n`,
    );
  });

  test("refuses two folders", async () => {
    const disk = registered("/work/billing");
    const before = disk.contents.get(REGISTRY);
    const { deps } = fakeDeps({ disk });
    expect(await cli(["unregister", "a", "b"], deps)).toBe(2);
    expect(disk.contents.get(REGISTRY)).toBe(before);
  });
});
