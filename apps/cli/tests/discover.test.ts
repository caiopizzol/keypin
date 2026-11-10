import { assert, describe, expect, test } from "vite-plus/test";
import { isRecord, parseMap, type StoreRead } from "@keypin/core";
import { cli } from "../src/cli";
import { fakeDeps, leaks, memoryFiles, parseJson, SENTINEL } from "./fakes";

const ACCOUNT = "11111111111111111111111111111111";
const ROOT = "/work/billing";

const FILES: Record<string, string> = {
  [`${ROOT}/.dev.vars`]: `STRIPE_KEY=${SENTINEL}\nexport LOCAL_ONLY="${SENTINEL}"\n`,
  [`${ROOT}/.dev.vars.example`]: `STRIPE_KEY=${SENTINEL}\nTODO_KEY=\n`,
  [`${ROOT}/web/.env.local`]: `VITE_KEY=${SENTINEL}\n`,
  [`${ROOT}/node_modules/pkg/.env`]: `IGNORED=${SENTINEL}\n`,
  [`${ROOT}/nested/.git/HEAD`]: "ref: refs/heads/main\n",
  [`${ROOT}/nested/.env`]: `NESTED=${SENTINEL}\n`,
  [`${ROOT}/wrangler.jsonc`]: `{
  "name": "billing",
  "account_id": "${ACCOUNT}",
  "vars": { "REGION": "${SENTINEL}" },
  "secrets": { "required": ["STRIPE_KEY", "WEBHOOK_SECRET"] },
}`,
  [`${ROOT}/.github/workflows/deploy.yml`]: `
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: deploy
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          MISSING: \${{ secrets.NOT_SET_ANYWHERE }}
`,
};

const FOLDERS = [
  ROOT,
  `${ROOT}/web`,
  `${ROOT}/node_modules`,
  `${ROOT}/node_modules/pkg`,
  `${ROOT}/nested`,
  `${ROOT}/nested/.git`,
  `${ROOT}/.github`,
  `${ROOT}/.github/workflows`,
];

interface Setup {
  files?: Record<string, string>;
  git?: Record<string, string | null>;
  github?: StoreRead | Error;
  worker?: StoreRead | Error;
}

function setup(options: Setup = {}) {
  const disk = memoryFiles({ ...FILES, ...options.files });
  for (const folder of FOLDERS) disk.folders.add(folder);
  const git: Record<string, string | null> = {
    "rev-parse --show-toplevel": `${ROOT}\n`,
    "remote get-url origin": "git@github.com:acme/billing.git\n",
    "config --get github.account": null,
    ...options.git,
  };
  const calls: string[] = [];
  const answer = (reply: StoreRead | Error | undefined, fallback: StoreRead) => {
    if (reply instanceof Error) throw reply;
    return reply ?? fallback;
  };
  const fake = fakeDeps({
    disk,
    deps: {
      git: async (folder, args) => {
        calls.push(`git ${args.join(" ")}`);
        if (args[0] === "ls-files") return git["ls-files"] ?? "";
        return git[args.join(" ")] ?? null;
      },
      githubSecrets: async (repo, login) => {
        calls.push(`github ${repo} as ${login}`);
        return answer(options.github, {
          ok: true,
          secrets: [
            { name: "CLOUDFLARE_API_TOKEN", updatedAt: "2026-11-01T10:00:00Z" },
            { name: "OLD_TOKEN", updatedAt: "2026-01-01T10:00:00Z" },
          ],
        });
      },
      workerSecrets: async (account, worker) => {
        calls.push(`worker ${account} ${worker}`);
        return answer(options.worker, {
          ok: true,
          secrets: [{ name: "STRIPE_KEY", updatedAt: null }],
        });
      },
    },
  });
  return { ...fake, calls };
}

function report(text: string) {
  const data = parseJson(text);
  assert(isRecord(data) && Array.isArray(data.names));
  return data;
}

describe("keypin discover", () => {
  test("lists every name, where it's set, its problems, and a draft that parses", async () => {
    const { deps, stdout, stderr, calls } = setup();
    expect(await cli(["discover"], deps)).toBe(0);
    const text = stdout.text;
    expect(text).toContain("GitHub: acme/billing as acme");
    expect(text).toMatch(/STRIPE_KEY {2}\[local and cloud\]/);
    expect(text).toContain("cloud: Worker billing (account 11111111…)");
    expect(text).toMatch(/LOCAL_ONLY {2}\[local\]/);
    expect(text).toMatch(/TODO_KEY {2}\[declared, not set\]/);
    expect(text).toMatch(/REGION {2}\[plain variable\]/);
    expect(text).toMatch(/OLD_TOKEN {2}\[cloud\]\n.*\n {4}! no workflow here references this/);
    expect(text).toMatch(/WEBHOOK_SECRET {2}\[declared, not set\][\s\S]*?doesn't have it/);
    expect(text).toContain(
      "Referenced by a workflow, and not a repo secret of acme/billing (1):\n  .github/workflows/deploy.yml: NOT_SET_ANYWHERE",
    );
    expect(text).toContain("not scanned (own git repository): nested");
    expect(text).not.toContain("IGNORED");
    expect(text).not.toContain("NESTED");
    expect(calls).toContain("github acme/billing as acme");
    expect(calls).toContain(`worker ${ACCOUNT} billing`);

    const draft = text.slice(text.indexOf("# Draft from keypin discover"));
    const parsed = parseMap(draft, "draft");
    assert(parsed.ok, JSON.stringify(parsed));
    expect(parsed.map.keys.map((k) => k.env).toSorted()).toEqual([
      "CLOUDFLARE_API_TOKEN",
      "LOCAL_ONLY",
      "OLD_TOKEN",
      "STRIPE_KEY",
      "VITE_KEY",
    ]);
    expect(leaks(text, stderr.text)).toBe(false);
  });

  test("--json holds the same data and no value", async () => {
    const { deps, stdout, stderr } = setup({ git: { "ls-files": ".dev.vars\0" } });
    expect(await cli(["discover", "--json"], deps)).toBe(0);
    const data = report(stdout.text);
    expect(data.repository).toBe("acme/billing");
    expect(data.files).toEqual({
      env: [
        { path: ".dev.vars", kind: "set", tracked: true },
        { path: ".dev.vars.example", kind: "expected", tracked: false },
        { path: "web/.env.local", kind: "set", tracked: false },
      ],
      wrangler: ["wrangler.jsonc"],
      workflows: [".github/workflows/deploy.yml"],
    });
    expect(JSON.stringify(data.problems)).toContain("tracked-env-file");
    expect(typeof data.draft).toBe("string");
    expect(leaks(stdout.text, stderr.text)).toBe(false);
  });

  test("uses git config github.account as the GitHub login", async () => {
    const { deps, calls } = setup({ git: { "config --get github.account": "me\n" } });
    expect(await cli(["discover"], deps)).toBe(0);
    expect(calls).toContain("github acme/billing as me");
  });

  test("says what's unknown when cloud reads fail, and doesn't call it none", async () => {
    const { deps, stdout, stderr } = setup({
      github: { ok: false, reason: "HTTP 403: the login isn't allowed" },
      worker: new Error(`the wrangler login reaches 2222, not ${ACCOUNT}`),
    });
    expect(await cli(["discover"], deps)).toBe(0);
    const text = stdout.text;
    expect(text).toContain("GitHub Actions secrets of acme/billing: as acme: HTTP 403");
    expect(text).toContain(
      `Worker secrets of billing (wrangler.jsonc): the wrangler login reaches 2222`,
    );
    expect(text).toMatch(/LOCAL_ONLY {2}\[local, cloud unknown\]/);
    expect(text).not.toContain("doesn't have it");
    expect(text).not.toContain("not a repo secret");
    expect(leaks(text, stderr.text)).toBe(false);
  });

  test("never guesses an account: no account_id means no Worker read", async () => {
    const { deps, stdout, calls } = setup({
      files: { [`${ROOT}/wrangler.jsonc`]: `{ "name": "billing" }` },
    });
    expect(await cli(["discover"], deps)).toBe(0);
    expect(calls.some((c) => c.startsWith("worker"))).toBe(false);
    expect(stdout.text).toContain(
      "Worker secrets of billing (wrangler.jsonc): wrangler.jsonc has no account_id, and discover doesn't guess an account",
    );
  });

  test("outside git, says the tracked state and GitHub secrets are unknown", async () => {
    const { deps, stdout, calls } = setup({
      git: { "rev-parse --show-toplevel": null, "remote get-url origin": null },
    });
    deps.git = async (_folder, args) => {
      calls.push(`git ${args.join(" ")}`);
      return null;
    };
    expect(await cli(["discover"], deps)).toBe(0);
    expect(stdout.text).toContain(
      "whether env files are tracked by git: the folder isn't in a git repository",
    );
    expect(stdout.text).toContain("GitHub Actions secrets: the folder isn't in a git repository");
    expect(calls.some((c) => c.startsWith("github"))).toBe(false);
  });

  test("an origin that isn't on GitHub is unknown, not empty", async () => {
    const { deps, stdout, calls } = setup({
      git: { "remote get-url origin": "https://gitlab.com/acme/billing.git\n" },
    });
    expect(await cli(["discover"], deps)).toBe(0);
    expect(stdout.text).toContain("GitHub Actions secrets: the origin remote isn't on github.com");
    expect(calls.some((c) => c.startsWith("github"))).toBe(false);
  });

  test("marks mapped names and drafts only the rest, with the map's vault", async () => {
    const { deps, stdout } = setup({
      files: {
        [`${ROOT}/keypin.toml`]: `[vaults.work]
kind = "1password"
account = "my.1password.com"
vault = "App Secrets"

[keys.stripe-key]
env = "STRIPE_KEY"
owner = "billing"
dev = { vault = "work", item = "billing dev stripe" }
`,
      },
    });
    expect(await cli(["discover"], deps)).toBe(0);
    expect(stdout.text).toMatch(/STRIPE_KEY {2}\[local and cloud, mapped\]/);
    const draft = stdout.text.slice(stdout.text.indexOf("# Draft from keypin discover"));
    expect(draft).toContain("[vaults.work]");
    expect(draft).not.toContain('env = "STRIPE_KEY"');
    const parsed = parseMap(draft, "draft");
    assert(parsed.ok, JSON.stringify(parsed));
    expect(parsed.map.keys.every((k) => k.owner === "billing")).toBe(true);
  });

  test("a bad keypin.toml is unknown, and its text isn't echoed", async () => {
    const { deps, stdout, stderr } = setup({
      files: { [`${ROOT}/keypin.toml`]: `[keys.x]\nenv = "${SENTINEL}\n` },
    });
    expect(await cli(["discover"], deps)).toBe(0);
    expect(stdout.text).toContain("which names keypin.toml maps: keypin.toml: not valid TOML");
    expect(leaks(stdout.text, stderr.text)).toBe(false);
  });

  test("a folder that doesn't exist is an error, and extra folders a usage error", async () => {
    const missing = setup();
    expect(await cli(["discover", "/nowhere"], missing.deps)).toBe(1);
    expect(missing.stderr.text).toContain("/nowhere isn't a folder");
    const extra = setup();
    expect(await cli(["discover", "a", "b"], extra.deps)).toBe(2);
    expect(extra.stderr.text).toContain("at most one folder");
  });
});
