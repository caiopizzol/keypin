import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { cli } from "../src/cli";
import { diskFiles, listFolder } from "../src/disk";
import { launch } from "../src/launch";
import { fakeDeps, fakeLauncher, fakeVault, leaks, memoryFiles, SENTINEL, WEB_MAP } from "./fakes";

const PROD_VALUE = "prod-value-that-run-never-reads";

interface SetupOptions {
  failing?: string[];
  code?: number;
  env?: Record<string, string>;
  files?: Record<string, string>;
  values?: Record<string, string>;
}

function setup(options: SetupOptions = {}) {
  const disk = memoryFiles({ "/work/web/keypin.toml": WEB_MAP, ...options.files });
  disk.folders.add("/work/web/src");
  const vault = fakeVault({
    values: {
      "web dev session secret": SENTINEL,
      "web prod session secret": PROD_VALUE,
      ...options.values,
    },
    failing: options.failing,
  });
  const launcher = fakeLauncher(options.code);
  const fake = fakeDeps({
    disk,
    backend: vault.vault,
    deps: {
      cwd: "/work/web/src",
      env: { PATH: "/usr/bin", ...options.env },
      launch: launcher.launch,
      onSignals: launcher.onSignals,
    },
  });
  return { ...fake, launcher, calls: vault.calls };
}

describe("keypin run", () => {
  test("adds only dev keys to the child's environment, found from a subfolder", async () => {
    const { deps, launcher, calls, stdout, stderr } = setup();
    expect(await cli(["run", "--", "sh", "-c", "echo hi"], deps)).toBe(0);
    expect(calls).toEqual(["read web dev session secret"]);
    expect(launcher.launches).toEqual([
      { command: ["sh", "-c", "echo hi"], env: { PATH: "/usr/bin", SESSION_SECRET: SENTINEL } },
    ]);
    expect(JSON.stringify(launcher.launches)).not.toContain(PROD_VALUE);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("op://Private/web dev session secret/password");
    expect(stderr.text).not.toContain("prod session secret");
    expect(leaks(stdout.text, stderr.text)).toBe(false);
  });

  test("--env reads another declared environment; an undeclared one is a usage error", async () => {
    const { deps, launcher, calls } = setup();
    expect(await cli(["run", "--env", "prod", "--", "true"], deps)).toBe(0);
    expect(calls).toEqual(["read web prod session secret"]);
    expect(launcher.launches[0]?.env.SESSION_SECRET).toBe(PROD_VALUE);
    const staging = setup();
    expect(await cli(["run", "--env", "staging", "--", "true"], staging.deps)).toBe(2);
    expect(staging.stderr.text).toContain(
      `--env is one of "dev", "prod" in /work/web/keypin.toml, got "staging"`,
    );
    expect(staging.launcher.launches).toHaveLength(0);
  });

  describe("--only", () => {
    const TWO_KEYS = `${WEB_MAP}
[keys.CLOUDFLARE_API_TOKEN]
prod = "op://Private/ci cloudflare token/credential"
`;
    const twoKeys = () =>
      setup({
        files: { "/work/web/keypin.toml": TWO_KEYS },
        values: { "ci cloudflare token": "ci-token" },
      });

    test("without it, every key the environment has is added", async () => {
      const { deps, launcher, calls } = twoKeys();
      expect(await cli(["run", "--env", "prod", "--", "true"], deps)).toBe(0);
      expect(calls).toHaveLength(2);
      expect(Object.keys(launcher.launches[0]?.env ?? {}).toSorted()).toEqual([
        "CLOUDFLARE_API_TOKEN",
        "PATH",
        "SESSION_SECRET",
      ]);
    });

    test("adds only the named keys and reads nothing else", async () => {
      for (const only of [["--only", "SESSION_SECRET"], ["--only=SESSION_SECRET,SESSION_SECRET"]]) {
        const { deps, launcher, calls, stderr } = twoKeys();
        expect(await cli(["run", "--env", "prod", ...only, "--", "true"], deps)).toBe(0);
        expect(calls).toEqual(["read web prod session secret"]);
        expect(launcher.launches).toEqual([
          { command: ["true"], env: { PATH: "/usr/bin", SESSION_SECRET: PROD_VALUE } },
        ]);
        expect(stderr.text).not.toContain("ci cloudflare token");
      }
    });

    test("a name the environment doesn't have is a usage error listing the ones it has", async () => {
      for (const name of ["CLOUDFLARE_API_TOKEN", "NOPE"]) {
        const { deps, launcher, calls, stderr } = twoKeys();
        expect(await cli(["run", "--only", name, "--", "true"], deps)).toBe(2);
        expect(stderr.text).toContain(`--only names keys dev has (SESSION_SECRET), got "${name}"`);
        expect(calls).toHaveLength(0);
        expect(launcher.launches).toHaveLength(0);
      }
    });
  });

  test("the first declared environment is the default", async () => {
    const map = `environments = ["local", "production"]\n${WEB_MAP.replace("\ndev = ", "\nlocal = ").replace("\nprod = ", "\nproduction = ")}`;
    const disk = memoryFiles({ "/work/web/keypin.toml": map });
    const vault = fakeVault({ values: { "web dev session secret": SENTINEL } });
    const launcher = fakeLauncher();
    const { deps } = fakeDeps({
      disk,
      backend: vault.vault,
      deps: { cwd: "/work/web", env: {}, launch: launcher.launch, onSignals: launcher.onSignals },
    });
    expect(await cli(["run", "--", "true"], deps)).toBe(0);
    expect(vault.calls).toEqual(["read web dev session secret"]);
  });

  test("a failed read starts nothing and names the key and item", async () => {
    const { deps, launcher, stderr } = setup({ failing: ["web dev session secret"] });
    expect(await cli(["run", "--", "true"], deps)).toBe(1);
    expect(launcher.launches).toHaveLength(0);
    expect(stderr.text).toContain("SESSION_SECRET (op://Private/web dev session secret/password)");
  });

  test("passes the child's exit code through", async () => {
    const { deps } = setup({ code: 42 });
    expect(await cli(["run", "--", "false"], deps)).toBe(42);
  });

  test("forwards signals to the child while it runs, then stops listening", async () => {
    const { deps, launcher } = setup();
    await cli(["run", "--", "sleep", "1"], deps);
    expect(launcher.kills).toEqual(["SIGINT"]);
    expect(launcher.listening).toBe(false);
  });

  test("the vault's value wins over an existing variable, and keypin says so by name", async () => {
    const { deps, launcher, stderr } = setup({ env: { SESSION_SECRET: "old" } });
    await cli(["run", "--", "true"], deps);
    expect(launcher.launches).toMatchObject([{ env: { SESSION_SECRET: SENTINEL } }]);
    expect(stderr.text).toContain("SESSION_SECRET was already set; using the vault's value");
    expect(leaks(stderr.text)).toBe(false);
  });

  test("needs a command and a keypin.toml", async () => {
    const { deps, launcher } = setup();
    expect(await cli(["run"], deps)).toBe(2);
    const none = fakeDeps({ deps: { cwd: "/work/billing" } });
    expect(await cli(["run", "--", "true"], none.deps)).toBe(1);
    expect(none.stderr.text).toContain(`no keypin.toml in /work/billing or any folder above it`);
    expect(launcher.launches).toHaveLength(0);
  });

  test("a value with a NUL character starts nothing and is named only by its variable", async () => {
    const disk = memoryFiles({ "/work/web/keypin.toml": WEB_MAP });
    const vault = fakeVault({ values: { "web dev session secret": `${SENTINEL}\0tail` } });
    let launched = 0;
    const { deps, stdout, stderr } = fakeDeps({
      disk,
      backend: vault.vault,
      deps: {
        cwd: "/work/web",
        launch: (command, env) => {
          launched++;
          return launch(command, env);
        },
      },
    });
    expect(await cli(["run", "--", "true"], deps)).toBe(1);
    expect(launched).toBe(0);
    expect(stderr.text).toContain("SESSION_SECRET contains a NUL character");
    expect(leaks(stdout.text, stderr.text)).toBe(false);
  });

  test("a launch error is reported by command and code, never by its message", async () => {
    const { deps, stdout, stderr } = setup();
    deps.launch = () => {
      throw Object.assign(new Error(`invalid env value "${SENTINEL}"`), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    };
    expect(await cli(["run", "--", "true"], deps)).toBe(1);
    expect(stderr.text).toContain(`couldn't start "true": ERR_INVALID_ARG_VALUE`);
    expect(leaks(stdout.text, stderr.text)).toBe(false);
  });

  test("the real launcher reports a missing command by code", async () => {
    const { deps, stdout, stderr } = setup();
    deps.launch = launch;
    expect(await cli(["run", "--", "keypin-no-such-command-zz"], deps)).toBe(1);
    expect(stderr.text).toContain(`couldn't start "keypin-no-such-command-zz": ENOENT`);
    expect(leaks(stdout.text, stderr.text)).toBe(false);
  });

  describe("env files that still hold a mapped key, and any .dev.vars", () => {
    const IGNORED =
      "wrangler dev ignores the keys keypin provides. Give each setting in it a new home, then delete the file.\n";

    test(".dev.vars with a mapped key: one warning names the file and key, and still starts", async () => {
      const { deps, launcher, stdout, stderr } = setup({
        files: { "/work/web/.dev.vars": `SESSION_SECRET=${SENTINEL}\nPORT=8787\n` },
      });
      expect(await cli(["run", "--", "wrangler", "dev"], deps)).toBe(0);
      expect(stderr.text).toContain(
        `keypin: ../.dev.vars still sets SESSION_SECRET, and while it exists ${IGNORED}`,
      );
      expect(stderr.text.split(".dev.vars")).toHaveLength(2);
      expect(stderr.text).not.toContain("PORT");
      expect(launcher.launches).toMatchObject([{ env: { SESSION_SECRET: SENTINEL } }]);
      expect(leaks(stdout.text, stderr.text)).toBe(false);
    });

    test(".dev.vars with only plain settings: says wrangler dev ignores keypin's keys", async () => {
      const { deps, launcher, stdout, stderr } = setup({
        files: {
          "/work/web/.dev.vars": `PORT=8787\n`,
          "/work/web/src/.dev.vars.staging": `DEBUG=1\n`,
        },
      });
      expect(await cli(["run", "--", "wrangler", "dev"], deps)).toBe(0);
      expect(stderr.text).toContain(`keypin: ../.dev.vars exists, so ${IGNORED}`);
      expect(stderr.text).toContain(`keypin: .dev.vars.staging exists, so ${IGNORED}`);
      expect(stderr.text).not.toContain("PORT");
      expect(launcher.launches).toMatchObject([{ env: { SESSION_SECRET: SENTINEL } }]);
      expect(leaks(stdout.text, stderr.text)).toBe(false);
    });

    test("no .dev.vars warning when the map provides no keys for this run", async () => {
      const { deps, launcher, stderr } = setup({
        files: {
          "/work/web/keypin.toml": `[1password]\naccount = "my.1password.com"\n`,
          "/work/web/.dev.vars": `PORT=8787\n`,
        },
      });
      expect(await cli(["run", "--", "wrangler", "dev"], deps)).toBe(0);
      expect(stderr.text).not.toContain(".dev.vars");
      expect(launcher.launches).toHaveLength(1);
    });

    test(".env.local in the current folder: says the file holds a plaintext copy", async () => {
      const { deps, launcher, stdout, stderr } = setup({
        files: { "/work/web/src/.env.local": `export SESSION_SECRET="${SENTINEL}"\n` },
      });
      expect(await cli(["run", "--", "true"], deps)).toBe(0);
      expect(stderr.text).toContain(
        "keypin: .env.local still holds a plaintext copy of SESSION_SECRET; tools differ on which value wins. Move it out of the file.\n",
      );
      expect(launcher.launches).toHaveLength(1);
      expect(leaks(stdout.text, stderr.text)).toBe(false);
    });

    test("no warning for unmapped names, example files, or no files", async () => {
      const files = {
        "/work/web/.env": `PORT=3000\nDEBUG=1\n`,
        "/work/web/.env.example": `SESSION_SECRET=\n`,
        "/work/web/.dev.vars.template": `SESSION_SECRET=${SENTINEL}\n`,
        "/work/web/src/nested/.env": `SESSION_SECRET=${SENTINEL}\n`,
      };
      for (const run of [setup({ files }), setup()]) {
        expect(await cli(["run", "--", "true"], run.deps)).toBe(0);
        expect(run.stderr.text).not.toContain("Move it out");
        expect(run.stderr.text).not.toContain(".dev.vars");
        expect(run.launcher.launches).toHaveLength(1);
      }
    });

    test("a file that isn't a regular file is skipped without reading it", async () => {
      const { deps, launcher, stderr } = setup();
      const reads: string[] = [];
      const files = deps.files;
      deps.files = { ...files, read: (path) => (reads.push(path), files.read(path)) };
      deps.listFolder = async () => [{ name: ".dev.vars", kind: "other" }];
      expect(await cli(["run", "--", "true"], deps)).toBe(0);
      expect(reads).not.toContain("/work/web/.dev.vars");
      expect(stderr.text).not.toContain(".dev.vars");
      expect(launcher.launches).toHaveLength(1);
    });

    test("a real FIFO named .env doesn't block run", async () => {
      const folder = await mkdtemp(join(tmpdir(), "keypin-run-"));
      try {
        await writeFile(join(folder, "keypin.toml"), WEB_MAP);
        expect(spawnSync("mkfifo", [join(folder, ".env")]).status).toBe(0);
        const { deps, launcher, stderr } = setup();
        deps.cwd = folder;
        deps.files = diskFiles;
        deps.listFolder = listFolder;
        expect(await cli(["run", "--", "true"], deps)).toBe(0);
        expect(stderr.text).not.toContain("Move it out");
        expect(launcher.launches).toHaveLength(1);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });
  });
});
