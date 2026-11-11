import { describe, expect, test } from "vite-plus/test";
import { cli } from "../src/cli";
import { launch } from "../src/launch";
import { fakeDeps, fakeLauncher, fakeVault, leaks, memoryFiles, SENTINEL, WEB_MAP } from "./fakes";

const PROD_VALUE = "prod-value-that-run-never-reads";

function setup(options: { failing?: string[]; code?: number; env?: Record<string, string> } = {}) {
  const disk = memoryFiles({ "/work/web/keypin.toml": WEB_MAP });
  disk.folders.add("/work/web/src");
  const vault = fakeVault({
    values: {
      "web dev session secret": SENTINEL,
      "web prod session secret": PROD_VALUE,
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
});
