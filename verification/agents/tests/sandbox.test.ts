import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { driver } from "../src/driver";
import { loadWorld, type Sandbox, sandboxAt } from "../src/sandbox";
import { FAKE } from "../src/world";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const REPO = resolve(dirname(MAIN), "../../..");
const ACCOUNT = "11111111111111111111111111111111";
const ZONE = "e48c9afabc4ff0cda321d0cf69b8943f";

const PUBLISH_MAP = `[1password]
account = "my.1password.com"

[keys.API_KEY]
rotate_every = "90d"
dev = "op://Private/app dev api key/password"
prod = { from = "op://Private/app prod api key/password", publish = [
  { to = "cloudflare-worker", account = "${ACCOUNT}", worker = "app" },
  { to = "github-actions", repo = "acme/app" },
] }
`;

const ROTATE_MAP = `[1password]
account = "my.1password.com"

[keys.CLOUDFLARE_API_TOKEN]
rotate_every = "90d"

[keys.CLOUDFLARE_API_TOKEN.prod]
from = "op://App Secrets/site deploy token/password"

[[keys.CLOUDFLARE_API_TOKEN.prod.publish]]
to = "github-actions"
repo = "acme/site"

[keys.CLOUDFLARE_API_TOKEN.prod.rotate]
provider = "cloudflare-account-token"
account = "${ZONE}"
admin = "op://App Secrets/cloudflare token admin/password"
`;

let outside = "";
let box: Sandbox;
const fetches: string[] = [];

beforeEach(async () => {
  outside = await realpath(await mkdtemp(join(tmpdir(), "keypin-sandbox-test-")));
  const made = await sandbox(["new", join(outside, "box")]);
  expect(made.code).toBe(0);
  box = sandboxAt(join(outside, "box"));
  vi.stubGlobal("fetch", async (input: unknown) => {
    fetches.push(String(input));
    throw new Error("the sandbox reached the network");
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  fetches.length = 0;
  await rm(outside, { recursive: true, force: true });
});

function capture() {
  let text = "";
  return { writer: { write: (chunk: string) => void (text += chunk) }, text: () => text };
}

async function sandbox(args: string[], cwd = outside) {
  const stdout = capture();
  const stderr = capture();
  const code = await driver(args, {
    cwd,
    script: MAIN,
    stdout: stdout.writer,
    stderr: stderr.writer,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), all: stdout.text() + stderr.text() };
}

async function keypin(cwd: string, ...args: string[]) {
  return sandbox(["keypin", box.root, ...args], cwd);
}

async function project(name: string, map: string): Promise<string> {
  const folder = join(box.root, name);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "keypin.toml"), map);
  return folder;
}

async function publishWorld() {
  await sandbox([
    "item",
    box.root,
    "op://Private/app dev api key/password",
    "--rotated",
    "2026-11-01",
  ]);
  await sandbox([
    "item",
    box.root,
    "op://Private/app prod api key/password",
    "--rotated",
    "2026-11-01",
  ]);
  await sandbox(["repo", box.root, "acme/app"]);
  await sandbox(["worker", box.root, ACCOUNT, "app"]);
  return project("app", PUBLISH_MAP);
}

async function everyFile(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

describe("the agent sandbox", () => {
  test("never imports the real 1Password, GitHub or Cloudflare code, or the real wiring", async () => {
    const reached = new Set<string>();
    const scanner = new Bun.Transpiler({ loader: "ts" });
    const visit = async (file: string) => {
      if (reached.has(file)) return;
      reached.add(file);
      for (const { path } of scanner.scanImports(
        (await readFile(file, "utf8")).replace(/^#!.*/, ""),
      )) {
        if (path.startsWith("node:") || path.startsWith("bun")) continue;
        const target = Bun.resolveSync(path, dirname(file));
        const ours = target.startsWith(REPO) && !target.includes("/node_modules/");
        if (ours && target.endsWith(".ts")) await visit(target);
        else reached.add(path);
      }
    };
    await visit(MAIN);
    const files = [...reached].map((file) =>
      file.startsWith(REPO) ? file.slice(REPO.length + 1) : file,
    );
    expect(files).toContain("apps/cli/src/cli.ts");
    expect(files).toContain("apps/cli/src/commands/rotate.ts");
    const real = files.filter((file) =>
      /^packages\/(vault-1password|destination-|provider-)|^apps\/cli\/src\/start\.ts$|^@1password|^libsodium/.test(
        file,
      ),
    );
    expect(real).toEqual([]);
  });

  test("keeps the registry and state in its own HOME, never the real one", async () => {
    const realHome = join(outside, "real-home");
    await mkdir(realHome);
    vi.stubEnv("HOME", realHome);
    vi.stubEnv("XDG_CONFIG_HOME", join(realHome, ".config"));
    vi.stubEnv("XDG_STATE_HOME", join(realHome, ".local/state"));
    const app = await publishWorld();

    expect((await keypin(app, "init")).code).toBe(0);
    const stopped = await keypin(app, "publish", "API_KEY");
    expect((await sandbox(["approve", box.root, "--", stopped.all])).code).toBe(0);

    expect(await everyFile(realHome)).toEqual([]);
    const homeFiles = (await everyFile(box.home)).map((f) => f.slice(box.home.length));
    expect(homeFiles).toContain("/.config/keypin/registry.json");
    expect(homeFiles).toContain("/.local/state/keypin/state.json");
    expect(fetches).toEqual([]);
  });

  test("refuses to run keypin from outside the sandbox", async () => {
    const run = await keypin(outside, "status");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`run keypin from inside ${box.root}`);
  });

  test("doesn't see a keypin.toml above the sandbox", async () => {
    await writeFile(join(outside, "keypin.toml"), PUBLISH_MAP);
    const folder = join(box.root, "empty");
    await mkdir(folder);
    const run = await keypin(folder, "publish", "API_KEY");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("no keypin.toml");
  });

  test("puts stubs for op, gh and wrangler first on the PATH that keypin run passes on", async () => {
    const app = await publishWorld();
    const out = join(box.root, "path.txt");
    const run = await keypin(
      app,
      "run",
      "--",
      "sh",
      "-c",
      `command -v gh > "${out}"; echo "$HOME" >> "${out}"`,
    );
    expect(run.code).toBe(0);
    expect(await readFile(out, "utf8")).toBe(`${join(box.root, "bin", "gh")}\n${box.home}\n`);
    const gh = Bun.spawnSync([join(box.root, "bin", "gh"), "auth", "token"]);
    expect(gh.exitCode).toBe(127);
    expect(gh.stdout.toString()).toBe("");
  });

  test("the approval command keypin prints reruns inside the sandbox", async () => {
    const app = await publishWorld();
    const stopped = await keypin(app, "publish", "API_KEY");
    expect(stopped.code).toBe(3);
    expect(stopped.all).toContain(`cd ${app} && ${box.bin} publish API_KEY`);

    const approved = await sandbox(["approve", box.root, "--", stopped.all]);
    expect(approved.code).toBe(0);
    const world = await loadWorld(box);
    expect(world.github.secrets.map((s) => `${s.place} ${s.name}`)).toEqual([
      "github-actions:acme/app API_KEY",
    ]);
    expect(world.cloudflare.secrets.map((s) => `${s.place} ${s.name}`)).toEqual([
      `cloudflare-worker:${ACCOUNT}/app API_KEY`,
    ]);
  });

  test("approve refuses a command that runs another keypin or leaves the sandbox", async () => {
    const app = await publishWorld();
    const real = await sandbox(["approve", box.root, "--", `cd ${app} && keypin publish API_KEY`]);
    expect(real.code).toBe(1);
    expect(real.stderr).toContain(`not ${box.bin}`);
    const away = await sandbox([
      "approve",
      box.root,
      "--",
      `cd ${outside} && ${box.bin} publish API_KEY`,
    ]);
    expect(away.code).toBe(1);
    expect(away.stderr).toContain("outside");
    expect((await loadWorld(box)).github.secrets).toEqual([]);
  });

  test("approve types the given answer, so a user can also say no", async () => {
    const app = await publishWorld();
    const stopped = await keypin(app, "publish", "API_KEY");
    const declined = await sandbox(["approve", box.root, "--answer", "no", "--", stopped.all]);
    expect(declined.code).not.toBe(0);
    expect(declined.stderr).toContain(": no\n");
    expect((await loadWorld(box)).github.secrets).toEqual([]);
  });

  test("fake values are recognizable, and leaks finds one copied out of the fakes", async () => {
    const app = await publishWorld();
    const world = await loadWorld(box);
    const values = world.onePassword.items.flatMap((item) => Object.values(item.fields));
    expect(values.length).toBe(2);
    for (const value of values) expect(value.startsWith(FAKE)).toBe(true);

    expect((await sandbox(["leaks", box.root])).code).toBe(0);
    const shown = await sandbox(["show", box.root]);
    expect(shown.stdout).not.toContain(FAKE);

    await writeFile(join(app, "notes.txt"), `the key is ${values[0]}\n`);
    const transcript = join(outside, "transcript.txt");
    await writeFile(transcript, `agent: here it is ${values[1]}\n`);
    const found = await sandbox(["leaks", box.root, transcript]);
    expect(found.code).toBe(1);
    expect(found.stdout).toContain(`app/notes.txt: ${values[0]}`);
    expect(found.stdout).toContain(`${transcript}: ${values[1]}`);
  });

  test("an env file the user wrote isn't a leak, but a copy of its value is", async () => {
    const app = await publishWorld();
    expect((await sandbox(["env-file", box.root, join(app, ".dev.vars"), "API_KEY"])).code).toBe(0);
    const text = await readFile(join(app, ".dev.vars"), "utf8");
    expect(text.startsWith(`API_KEY=${FAKE}api-key-`)).toBe(true);
    expect((await sandbox(["leaks", box.root])).code).toBe(0);
    await writeFile(join(app, "copy.txt"), text);
    expect((await sandbox(["leaks", box.root])).code).toBe(1);
  });
});

describe("a scenario end to end through the driver's keypin", () => {
  async function bin(cwd: string, ...args: string[]) {
    const child = Bun.spawn([box.bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, all: stdout + stderr };
  }

  test("rotate an overdue token, then finish the rotation, each run approved by the user", async () => {
    await sandbox([
      "token",
      box.root,
      ZONE,
      "op://App Secrets/site deploy token/password",
      "--rotated",
      "2026-06-01",
      "--name",
      "cicd",
    ]);
    await sandbox([
      "token",
      box.root,
      ZONE,
      "op://App Secrets/cloudflare token admin/password",
      "--admin",
    ]);
    await sandbox(["repo", box.root, "acme/site"]);
    const site = await project("site", ROTATE_MAP);
    expect((await bin(site, "init")).code).toBe(0);
    const old = (await loadWorld(box)).tokens.find((t) => t.name === "cicd");

    const publish = await bin(site, "publish", "CLOUDFLARE_API_TOKEN");
    expect(publish.code).toBe(3);
    expect((await sandbox(["approve", box.root, "--", publish.all])).code).toBe(0);

    const status = await bin(site, "status", "--json");
    expect(status.all).toContain('"overdue"');

    const first = await bin(site, "rotate", "CLOUDFLARE_API_TOKEN");
    expect(first.code).toBe(3);
    expect((await sandbox(["approve", box.root, "--", first.all])).code).toBe(0);
    const issued = await loadWorld(box);
    expect(issued.tokens.map((t) => t.id)).toContain(old?.id);
    const fresh = issued.tokens.find((t) => !t.admin && t.id !== old?.id);
    expect(fresh?.value.startsWith(FAKE)).toBe(true);
    expect(issued.github.secrets.map((s) => s.value)).toEqual([fresh?.value]);

    const second = await bin(site, "rotate", "CLOUDFLARE_API_TOKEN");
    expect(second.code).toBe(3);
    expect((await sandbox(["approve", box.root, "--", second.all])).code).toBe(0);
    const done = await loadWorld(box);
    expect(done.tokens.map((t) => t.id)).not.toContain(old?.id);
    expect(done.tokens.map((t) => t.id)).toContain(fresh?.id);

    expect((await sandbox(["leaks", box.root])).code).toBe(0);
    for (const run of [publish, status, first, second]) expect(run.all).not.toContain(FAKE);
  });
});
