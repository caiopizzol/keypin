import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import root from "../../package.json";
import github from "../../packages/destination-github/package.json";
import vault from "../../packages/vault-1password/package.json";
import { MIN_BUN } from "./src/runtime";

const repo = join(import.meta.dir, "../..");
const out = join(import.meta.dir, "dist");
const dependencies = {
  "@1password/sdk": vault.dependencies["@1password/sdk"],
  "libsodium-wrappers": github.dependencies["libsodium-wrappers"],
};

await rm(out, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "src/main.ts")],
  outdir: out,
  target: "bun",
  splitting: true,
  external: Object.keys(dependencies),
});
if (!result.success) throw new AggregateError(result.logs, "keypin: the build failed");

const manifest = {
  name: root.name,
  version: root.version,
  description: root.description,
  license: root.license,
  homepage: root.homepage,
  bugs: root.bugs,
  repository: root.repository,
  type: "module",
  bin: { keypin: "main.js" },
  engines: { bun: `>=${MIN_BUN}` },
  dependencies,
};
await Bun.write(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await copyFile(join(repo, "README.md"), join(out, "README.md"));
await copyFile(join(repo, "LICENSE"), join(out, "LICENSE"));
