import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import root from "../../../package.json";
import { LAUNCHER } from "../compile";
import { packKeypin, packTarget } from "../pack";
import { platformPackage, TARGETS } from "../src/layout";

let out = "";
beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), "keypin-pack-"));
});
afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

async function manifest(folder: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
}

describe("pack", () => {
  test("keypin is the launcher, pinned to each platform package at its own version", async () => {
    const folder = await packKeypin(out);
    const keypin = await manifest(folder);
    expect(keypin.name).toBe("keypin");
    expect(keypin.version).toBe(root.version);
    expect(keypin.bin).toEqual({ keypin: "bin/keypin" });
    expect(keypin.optionalDependencies).toEqual(
      Object.fromEntries(TARGETS.map((target) => [platformPackage(target), root.version])),
    );
    expect(keypin).not.toHaveProperty("dependencies");
    expect(keypin).not.toHaveProperty("scripts");
    expect(await readFile(join(folder, "bin/keypin"), "utf8")).toBe(
      await readFile(LAUNCHER, "utf8"),
    );
    expect((await stat(join(folder, "bin/keypin"))).mode & 0o111).toBe(0o111);
  });

  test("each platform package holds only its binary, for its own os and cpu", async () => {
    const binary = join(out, "fake-binary");
    await writeFile(binary, "binary");
    for (const target of TARGETS) {
      const folder = await packTarget(target, out, binary);
      const platform = await manifest(folder);
      const [os, cpu] = target.split("-");
      expect(platform).toMatchObject({
        name: platformPackage(target),
        version: root.version,
        os: [os],
        cpu: [cpu],
        files: ["bin/keypin"],
      });
      expect(platform).not.toHaveProperty("scripts");
      expect(platform).not.toHaveProperty("bin");
      expect((await stat(join(folder, "bin/keypin"))).mode & 0o111).toBe(0o111);
    }
  });
});
