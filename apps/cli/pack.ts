import { chmod, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import root from "../../package.json";
import { binaryPath, LAUNCHER } from "./compile";
import { platformPackage, type Target, TARGETS } from "./src/layout";

const here = fileURLToPath(new URL(".", import.meta.url));
export const PACKAGES = join(here, "packages");
const repo = join(here, "../..");

const common = {
  version: root.version,
  license: root.license,
  homepage: root.homepage,
  bugs: root.bugs,
  repository: root.repository,
};

function platformOf(target: Target) {
  const [os, cpu] = target.split("-");
  return { os: [os], cpu: [cpu] };
}

async function writeJson(path: string, value: object) {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function packTarget(
  target: Target,
  out = PACKAGES,
  binary = binaryPath(target),
): Promise<string> {
  const folder = join(out, `cli-${target}`);
  await rm(folder, { recursive: true, force: true });
  await mkdir(join(folder, "bin"), { recursive: true });
  await copyFile(binary, join(folder, "bin/keypin"));
  await chmod(join(folder, "bin/keypin"), 0o755);
  await copyFile(join(repo, "LICENSE"), join(folder, "LICENSE"));
  await writeJson(join(folder, "package.json"), {
    name: platformPackage(target),
    ...common,
    description: `The keypin binary for ${target}. Install keypin, not this package.`,
    ...platformOf(target),
    files: ["bin/keypin"],
  });
  return folder;
}

export async function packKeypin(out = PACKAGES): Promise<string> {
  const folder = join(out, "keypin");
  await rm(folder, { recursive: true, force: true });
  await mkdir(join(folder, "bin"), { recursive: true });
  await copyFile(LAUNCHER, join(folder, "bin/keypin"));
  await chmod(join(folder, "bin/keypin"), 0o755);
  await copyFile(join(repo, "README.md"), join(folder, "README.md"));
  await copyFile(join(repo, "LICENSE"), join(folder, "LICENSE"));
  await writeJson(join(folder, "package.json"), {
    name: root.name,
    ...common,
    description: root.description,
    bin: { keypin: "bin/keypin" },
    files: ["bin/keypin"],
    os: ["darwin", "linux"],
    cpu: ["arm64", "x64"],
    optionalDependencies: Object.fromEntries(
      TARGETS.map((target) => [platformPackage(target), root.version]),
    ),
  });
  return folder;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

if (import.meta.main) {
  const missing = [];
  for (const target of TARGETS) if (!(await exists(binaryPath(target)))) missing.push(target);
  if (missing.length) {
    process.stderr.write(`no binary for ${missing.join(", ")}; run bun run compile first\n`);
    process.exit(1);
  }
  await rm(PACKAGES, { recursive: true, force: true });
  for (const target of TARGETS) process.stdout.write(`${await packTarget(target)}\n`);
  process.stdout.write(`${await packKeypin()}\n`);
}
