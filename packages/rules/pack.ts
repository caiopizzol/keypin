import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import root from "../../package.json";

const here = fileURLToPath(new URL(".", import.meta.url));
export const PACKAGE = join(here, "npm");

export async function packRules(out = PACKAGE): Promise<string> {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(join(here, "dist"), join(out, "dist"), { recursive: true });
  await copyFile(join(here, "../../LICENSE"), join(out, "LICENSE"));
  const manifest = {
    name: "@keypin/rules",
    version: root.version,
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
  await Bun.write(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return out;
}

if (import.meta.main) await packRules();
