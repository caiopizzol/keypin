import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "@keypin/core";
import { version } from "../../package.json";
import { LAUNCHER } from "./compile";
import { packKeypin, packTarget } from "./pack";
import {
  hostTarget,
  launchedBinary,
  launcherHash,
  platformPackage,
  type Target,
  TARGETS,
} from "./src/layout";
import { selfFor } from "./src/self";

const binary = process.argv[2];
if (!binary) {
  process.stderr.write("usage: bun apps/cli/check-binary.ts <compiled keypin>\n");
  process.exit(2);
}
function shippedHost(): Target {
  const found = hostTarget();
  if (found) return found;
  process.stderr.write(`keypin ships no binary for ${process.platform}-${process.arch}\n`);
  process.exit(2);
}
const host = shippedHost();

const repo = resolve(import.meta.dir, "../..");
const launcherText = await readFile(LAUNCHER, "utf8");
const root = await realpath(await mkdtemp(join(tmpdir(), "keypin-binary-")));
const folder = join(root, "project");
const failures: string[] = [];

function expect(name: string, ok: boolean, detail: string) {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}\n`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

const BASE_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
};

async function spawn(command: string[], env: Record<string, string>, cwd = folder) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

const STATUS = ["status"];
const BUN_REFUSES_PRELOAD = 'error: Script not found "x"\n';

async function checkKeypin(
  label: string,
  keypin: string[],
  extra: Record<string, string> = {},
  runner = false,
) {
  const run = (args: string[], more: Record<string, string> = {}) =>
    spawn([...keypin, ...args], { ...BASE_ENV, ...extra, ...more });

  const shown = await run(["--version"]);
  expect(
    `${label}: --version`,
    shown.code === 0 && shown.stdout === `${version}\n`,
    shown.stdout + shown.stderr,
  );

  const help = await run(["--help"]);
  expect(`${label}: --help`, help.code === 0 && help.stdout.startsWith("Usage:"), help.stderr);

  const status = await run(["status"]);
  expect(
    `${label}: status with empty config and state folders`,
    status.code === 0 && status.stdout.includes("No projects registered"),
    status.stdout + status.stderr,
  );

  for (const [name, value] of [
    ["BUN_OPTIONS", "--env-file=.env"],
    ["BUN_OPTIONS", "--preload ./preload.js"],
    ["BUN_INSPECT", "127.0.0.1:0"],
    ["BUN_INSPECT_CONNECT_TO", "unix:///nowhere"],
  ] as const) {
    const refused = await run(STATUS, { [name]: value });
    const ownRefusal =
      refused.code === 1 && refused.stderr.includes(`keypin can't run with ${name} set`);
    const bunRefusal =
      runner &&
      value.startsWith("--preload") &&
      refused.code === 1 &&
      refused.stderr === BUN_REFUSES_PRELOAD;
    expect(
      `${label}: ${name}=${value} is refused before the command runs`,
      refused.stdout === "" && (ownRefusal || bunRefusal),
      `exit ${refused.code}, stdout ${JSON.stringify(refused.stdout)}, stderr ${refused.stderr}`,
    );
  }

  expect(
    `${label}: the folder's bunfig.toml preload never ran`,
    !existsSync(join(folder, "preloaded")),
    "bunfig.toml's preload wrote its marker file",
  );
}

interface Published {
  manifest: Record<string, unknown>;
  tarball: Uint8Array<ArrayBuffer>;
}

async function packed(packageFolder: string, out: string): Promise<Published> {
  const result = await spawn(
    ["npm", "pack", "--silent", "--pack-destination", out],
    { ...BASE_ENV, PATH: process.env.PATH ?? BASE_ENV.PATH, npm_config_cache: join(root, "npm") },
    packageFolder,
  );
  if (result.code !== 0) throw new Error(`npm pack failed in ${packageFolder}: ${result.stderr}`);
  const manifest: unknown = JSON.parse(await readFile(join(packageFolder, "package.json"), "utf8"));
  if (!isRecord(manifest)) throw new Error(`${packageFolder}/package.json isn't a JSON object`);
  return { manifest, tarball: new Uint8Array(await readFile(join(out, result.stdout.trim()))) };
}

function registry(packages: Published[]) {
  const byName = new Map(packages.map((p) => [String(p.manifest.name), p]));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request): Response {
      const path = decodeURIComponent(new URL(request.url).pathname).slice(1);
      if (path.startsWith("tarballs/")) {
        const found = byName.get(path.slice("tarballs/".length));
        return found ? new Response(found.tarball) : new Response("not found", { status: 404 });
      }
      const found = byName.get(path);
      if (!found) return Response.json({ error: "not found" }, { status: 404 });
      const integrity = `sha512-${createHash("sha512").update(found.tarball).digest("base64")}`;
      const shasum = createHash("sha1").update(found.tarball).digest("hex");
      return Response.json({
        name: path,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            ...found.manifest,
            dist: { tarball: `${server.url.href}tarballs/${path}`, integrity, shasum },
          },
        },
      });
    },
  });
  return server;
}

async function checkInstalled() {
  const packages = join(root, "packages");
  const tarballs = join(root, "tarballs");
  await mkdir(tarballs);
  const placeholder = join(root, "placeholder");
  await writeFile(placeholder, "#!/bin/sh\nexit 99\n");
  const published = [await packed(await packKeypin(packages), tarballs)];
  for (const target of TARGETS) {
    const folder = await packTarget(target, packages, target === host ? binary : placeholder);
    published.push(await packed(folder, tarballs));
  }
  const keypinPins = published[0]?.manifest.optionalDependencies;
  expect(
    "keypin pins every platform package to its own version",
    JSON.stringify(keypinPins) ===
      JSON.stringify(Object.fromEntries(TARGETS.map((t) => [platformPackage(t), version]))),
    JSON.stringify(keypinPins),
  );

  const server = registry(published);
  const toolPath = process.env.PATH ?? BASE_ENV.PATH;
  const npmEnv = {
    ...BASE_ENV,
    PATH: toolPath,
    npm_config_cache: join(root, "npm"),
    npm_config_registry: server.url.href,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_ignore_scripts: "true",
  };
  try {
    const npmPrefix = join(root, "npm-global");
    const npm = await spawn(
      ["npm", "install", "--global", "--prefix", npmPrefix, `keypin@${version}`],
      npmEnv,
      root,
    );
    expect("npm install --global keypin", npm.code === 0, npm.stderr);
    if (npm.code === 0) await checkKeypin("npm -g", [join(npmPrefix, "bin/keypin")]);

    const bin = join(npmPrefix, "bin");
    const installed = [
      join(npmPrefix, "lib/node_modules/keypin/node_modules"),
      join(npmPrefix, "lib/node_modules"),
    ].map((modules) => join(modules, platformPackage(host), "bin/keypin"));
    const running = installed.find((path) => existsSync(path)) ?? installed[0] ?? "";
    const linked = join(root, "link");
    await symlink(folder, linked);
    const self = selfFor({
      full: [running],
      running: [running],
      cwd: folder,
      version,
      env: { PATH: `${bin}:${BASE_ENV.PATH}`, PWD: linked },
      which: (name, path) => Bun.which(name, { PATH: path }),
      real: (path) => (existsSync(path) ? realpathSync(path) : null),
      launches: (path) =>
        launchedBinary(path, {
          hash: launcherHash(launcherText),
          target: host,
          size: (file) => (existsSync(file) ? statSync(file).size : null),
          read: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null),
          exists: existsSync,
        }),
    });
    expect(
      "npm -g: the command to approve is keypin, in the folder as typed",
      self.command.join(" ") === "keypin" && self.folder === linked,
      JSON.stringify(self),
    );

    const modules = join(npmPrefix, "lib/node_modules");
    for (const installed of [modules, join(modules, "keypin/node_modules")])
      await rm(join(installed, platformPackage(host)), { recursive: true, force: true });
    const missing = await spawn([join(npmPrefix, "bin/keypin"), ...STATUS], BASE_ENV);
    expect(
      "without the platform package, keypin says which package is missing",
      missing.code === 1 &&
        missing.stdout === "" &&
        missing.stderr.includes(`the package ${platformPackage(host)} isn't installed`),
      `exit ${missing.code}, stderr ${missing.stderr}`,
    );

    const bunEnv = {
      ...BASE_ENV,
      PATH: toolPath,
      BUN_INSTALL: join(root, "bun"),
      BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
      BUN_CONFIG_REGISTRY: server.url.href,
    };
    const bun = await spawn(
      [process.execPath, "add", "--global", `keypin@${version}`],
      bunEnv,
      root,
    );
    expect("bun add --global keypin", bun.code === 0, bun.stderr);
    if (bun.code === 0) await checkKeypin("bun add -g", [join(root, "bun/bin/keypin")]);

    const bunx = {
      BUN_INSTALL_CACHE_DIR: bunEnv.BUN_INSTALL_CACHE_DIR,
      BUN_CONFIG_REGISTRY: bunEnv.BUN_CONFIG_REGISTRY,
    };
    await checkKeypin("bun x", [process.execPath, "x", `keypin@${version}`], bunx, true);
  } finally {
    await server.stop(true);
  }
}

try {
  await mkdir(folder);
  const keypin = join(folder, "keypin");
  await copyFile(binary, keypin);
  await writeFile(join(folder, ".env"), "FAKE_X=leak\n");
  await writeFile(join(folder, "preload.js"), "export {};\n");
  await writeFile(join(folder, "bunfig.toml"), 'preload = ["./mark.js"]\n');
  await writeFile(
    join(folder, "mark.js"),
    'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./preloaded", import.meta.url), "");\n',
  );

  const bytes = Buffer.from(await Bun.file(keypin).arrayBuffer());
  expect(
    "the binary holds no path into this checkout",
    !bytes.includes(Buffer.from(repo)),
    `it contains ${repo}, so it reads a file from the build machine at run time`,
  );

  expect(
    "the binary knows the npm launcher, so it can tell when keypin on PATH runs it",
    bytes.includes(Buffer.from(launcherHash(launcherText))),
    "launcher.sh changed after this binary was compiled",
  );

  await checkKeypin("binary", [keypin]);
  await checkInstalled();
} finally {
  await rm(root, { recursive: true, force: true });
}

if (failures.length) {
  process.stderr.write(`\n${failures.join("\n")}\n`);
  process.exit(1);
}
