import { describe, expect, test } from "vite-plus/test";
import { cli } from "../src/cli";
import { template } from "../src/commands/init";
import {
  fakeDeps,
  fakeDestinations,
  fakeLauncher,
  fakeVault,
  leaks,
  memoryFiles,
  SENTINEL,
} from "./fakes";
import { changes, recording } from "./recording";

const ROOT = "/work/billing";
const MAP = `${ROOT}/secretspec.toml`;

const PROJECT: Record<string, string> = {
  [`${ROOT}/.env`]: `DATABASE_URL=${SENTINEL}-database\nRESEND_API_KEY=${SENTINEL}-resend\n`,
  [`${ROOT}/wrangler.toml`]: `name = "billing-worker"
account_id = "11111111111111111111111111111111"

[secrets]
required = ["RESEND_API_KEY"]
`,
  [`${ROOT}/.github/workflows/deploy.yml`]: `on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: deploy
        env:
          STRIPE_API_KEY: \${{ secrets.STRIPE_API_KEY }}
`,
};

const GIT: Record<string, string> = {
  "rev-parse --show-toplevel": `${ROOT}\n`,
  "remote get-url origin": "git@github.com:acme/billing.git\n",
};

function journey() {
  const disk = memoryFiles(PROJECT);
  for (const folder of [`${ROOT}/.github`, `${ROOT}/.github/workflows`]) disk.folders.add(folder);
  const vault = fakeVault({
    items: [],
    values: { "secretspec/billing/production/STRIPE_API_KEY": `${SENTINEL}-stripe` },
  });
  const destinations = fakeDestinations();
  const launcher = fakeLauncher();

  const step = async (name: string, args: string[], terminal = false) => {
    const asked: string[] = [];
    const calls = vault.calls.length;
    const log = destinations.log.length;
    const fake = fakeDeps({
      disk,
      backend: vault.vault,
      deps: {
        self: { folder: ROOT, command: ["keypin"] },
        git: async (_folder, gitArgs) =>
          gitArgs[0] === "ls-files" ? "" : (GIT[gitArgs.join(" ")] ?? null),
        githubSecrets: async () => ({ ok: true, secrets: [] }),
        workerSecrets: async () => ({ ok: true, secrets: [] }),
        destination: destinations.build,
        launch: launcher.launch,
        onSignals: launcher.onSignals,
        isTerminal: terminal,
        ask: async (question) => {
          asked.push(question);
          return "y";
        },
      },
    });
    const before = new Map(disk.contents);
    const exit = await cli(args, fake.deps);
    expect(leaks(fake.stdout.text, fake.stderr.text)).toBe(false);
    await expect(
      recording({
        args,
        exit,
        stdout: fake.stdout.text,
        stderr: fake.stderr.text,
        given: { terminal },
        calls: {
          vault: vault.calls.slice(calls),
          destination: destinations.log.slice(log),
          asked,
        },
        wrote: changes(before, disk.contents),
      }),
    ).toMatchFileSnapshot(`./recordings/get-started/${name}.txt`);
    return { exit, stdout: fake.stdout.text };
  };

  return { disk, launcher, destinations, step };
}

function tomlToAdd(stdout: string): string {
  const toml = /keypin rejects a map that still has one:\n\n([\s\S]*?)\n\n {2}Then run/.exec(
    stdout,
  )?.[1];
  if (toml === undefined) throw new Error("check printed no TOML to add");
  return toml;
}

describe("the Get started pages, one project from init to publish", () => {
  test("each step's output is recorded, and the TOML check prints pastes into the map", async () => {
    const { disk, launcher, destinations, step } = journey();

    expect((await step("init", ["init"])).exit).toBe(0);
    expect(disk.contents.get(MAP)).toBe(template("billing"));
    expect((await step("check-after-init", ["check"])).exit).toBe(1);

    const local = ["import", ".env", "DATABASE_URL", "RESEND_API_KEY", "--vault", "Private"];
    const account = ["--account", "my.1password.com"];
    expect((await step("import", [...local, ...account], true)).exit).toBe(0);
    disk.contents.delete(`${ROOT}/.env`);

    expect((await step("run", ["run", "--", "npm", "run", "dev"])).exit).toBe(0);
    expect(launcher.launches[0]?.env).toMatchObject({
      DATABASE_URL: `${SENTINEL}-database`,
      RESEND_API_KEY: `${SENTINEL}-resend`,
    });

    const before = await step("check-before-destinations", ["check"]);
    expect(before.exit).toBe(1);
    const add = tomlToAdd(before.stdout);
    expect(add).not.toContain("<");
    disk.contents.set(MAP, `${disk.contents.get(MAP)}\n${add}\n`);

    expect((await step("check-after-destinations", ["check"])).exit).toBe(1);
    expect((await step("publish-plan", ["publish", "STRIPE_API_KEY", "--plan"])).exit).toBe(3);
    expect((await step("publish", ["publish", "STRIPE_API_KEY"], true)).exit).toBe(0);
    expect(destinations.delivered(`${SENTINEL}-stripe`)).toEqual([
      "github-actions:acme/billing STRIPE_API_KEY",
    ]);
  });
});
