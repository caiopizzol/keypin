import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import root from "../../package.json";

const here = fileURLToPath(new URL(".", import.meta.url));
const FOLDER = join(here, "npm");
export const TARBALL = join(here, `keypin-rules-${root.version}.tgz`);

export async function packRules(): Promise<string> {
  await rm(FOLDER, { recursive: true, force: true });
  await rm(TARBALL, { force: true });
  await mkdir(FOLDER, { recursive: true });
  await cp(join(here, "dist"), join(FOLDER, "dist"), { recursive: true });
  await copyFile(join(here, "../../LICENSE"), join(FOLDER, "LICENSE"));
  const manifest = {
    name: "@keypin/rules",
    version: root.version,
    private: true,
    description:
      "keypin's rules for keypin.toml, without the CLI: read a map and answer what it means.",
    license: root.license,
    homepage: root.homepage,
    bugs: root.bugs,
    repository: { ...root.repository, directory: "packages/rules" },
    type: "module",
    sideEffects: false,
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    files: ["dist"],
  };
  await Bun.write(join(FOLDER, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const packed = Bun.spawnSync(["npm", "pack", "--pack-destination", here], {
    cwd: FOLDER,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (packed.exitCode !== 0 || !(await Bun.file(TARBALL).exists()))
    throw new Error(`npm pack didn't write ${TARBALL}: ${packed.stderr.toString()}`);
  return TARBALL;
}

if (import.meta.main) await packRules();
