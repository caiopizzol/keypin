import { assert, describe, expect, test } from "vite-plus/test";
import { isRecord, parseMap, type StoreRead } from "@keypin/core";
import { CloudflareReader } from "@keypin/destination-cloudflare";
import { cli } from "../src/cli";
import { TEMPLATE } from "../src/commands/init";
import type { Deps } from "../src/deps";
import {
  fakeDeps,
  fakeDestinations,
  fakeVault,
  leaks,
  memoryFiles,
  parseJson,
  REGISTRY,
  registryWith,
  SENTINEL,
} from "./fakes";

const ACCOUNT = "11111111111111111111111111111111";
const ROOT = "/work/billing";
const MAP = `${ROOT}/keypin.toml`;

const PROJECT: Record<string, string> = {
  [`${ROOT}/.env`]: `DATABASE_URL=${SENTINEL}\nRESEND_API_KEY=${SENTINEL}\n`,
  [`${ROOT}/.env.example`]: `DATABASE_URL=\n`,
  [`${ROOT}/wrangler.toml`]: `name = "billing-worker"
account_id = "${ACCOUNT}"

[vars]
REGION = "${SENTINEL}"

[secrets]
required = ["RESEND_API_KEY"]
`,
  [`${ROOT}/.github/workflows/deploy.yml`]: `
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: deploy
        env:
          STRIPE_API_KEY: \${{ secrets.STRIPE_API_KEY }}
          TOKEN: \${{ secrets.GITHUB_TOKEN }}
`,
};

const MAPPED = `[1password]
account = "my.1password.com"

[keys.DATABASE_URL]
rotate_every = "90d"
dev = "op://Private/billing dev database url/password"

[keys.RESEND_API_KEY]
rotate_every = "90d"
dev = "op://Private/billing dev resend api key/password"
`;

const PUBLISHED = `${MAPPED}
[keys.RESEND_API_KEY.prod]
from = "op://Private/billing prod resend api key/password"

[[keys.RESEND_API_KEY.prod.publish]]
to = "cloudflare-worker"
account = "${ACCOUNT}"
worker = "billing-worker"

[keys.STRIPE_API_KEY]
rotate_every = "90d"

[keys.STRIPE_API_KEY.prod]
from = "op://Private/billing prod stripe api key/password"

[[keys.STRIPE_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

interface Setup {
  files?: Record<string, string | null>;
  git?: Record<string, string | null>;
  github?: StoreRead | Error;
  worker?: StoreRead | Error;
  deps?: Partial<Deps>;
}

function setup(options: Setup = {}) {
  const initial: Record<string, string> = { ...PROJECT, [REGISTRY]: registryWith(ROOT) };
  for (const [path, text] of Object.entries(options.files ?? {})) {
    if (text === null) delete initial[path];
    else initial[path] = text;
  }
  const disk = memoryFiles(initial);
  for (const folder of [`${ROOT}/.github`, `${ROOT}/.github/workflows`]) disk.folders.add(folder);
  const before = new Map(disk.contents);
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
  const vault = fakeVault({
    values: {
      "billing dev database url": SENTINEL,
      "billing dev resend api key": SENTINEL,
      "billing prod resend api key": SENTINEL,
      "billing prod stripe api key": SENTINEL,
      "billing prod item": SENTINEL,
    },
  });
  const destinations = fakeDestinations();
  const fake = fakeDeps({
    disk,
    backend: vault.vault,
    deps: {
      git: async (_folder, args) => {
        calls.push(`git ${args.join(" ")}`);
        if (args[0] === "ls-files") return git["ls-files"] ?? "";
        return git[args.join(" ")] ?? null;
      },
      githubSecrets: async (repo, login) => {
        calls.push(`github ${repo} as ${login}`);
        return answer(options.github, { ok: true, secrets: [] });
      },
      workerSecrets: async (account, worker) => {
        calls.push(`worker ${account} ${worker}`);
        return answer(options.worker, { ok: true, secrets: [] });
      },
      destination: destinations.build,
      ...options.deps,
    },
  });
  const unchanged = () => expect(disk.contents).toEqual(before);
  const everything = () => [fake.stdout.text, fake.stderr.text];
  return { ...fake, calls, vault: vault.calls, log: destinations.log, unchanged, everything };
}

function json(
  text: string,
): Record<string, unknown> & { problems: unknown[]; production: unknown[] } {
  const data = parseJson(text);
  assert(isRecord(data));
  const { problems, production } = data;
  assert(Array.isArray(problems) && Array.isArray(production));
  return { ...data, problems, production };
}

function added(text: string): string {
  const marker = "keypin rejects a map that still has one):\n\n";
  const at = text.indexOf(marker);
  assert(at !== -1, text);
  return text.slice(at + marker.length);
}

const FILLED: [string, string][] = [
  ["<1Password sign-in address>", "my.1password.com"],
  ["op://<vault>/<item>/<field>", "op://Private/billing prod item/password"],
];

function fill(toml: string): string {
  return FILLED.reduce((text, [from, to]) => text.replaceAll(from, to), toml);
}

describe("keypin check on a whole project", () => {
  test("right after init: no vault reads, every gap, and the TOML to add", async () => {
    const run = setup({ files: { [MAP]: TEMPLATE } });
    expect(await cli(["check"], run.deps)).toBe(1);
    const text = run.stdout.text;
    expect(run.vault).toEqual([]);
    expect(run.log).toEqual([]);
    expect(run.calls).toContain("github acme/billing as null");
    expect(run.calls).toContain(`worker ${ACCOUNT} billing-worker`);
    expect(text).toContain(`Problems (3):
  ${MAP} maps no keys yet; run keypin import for an env file, and add the TOML below for production
  STRIPE_API_KEY: .github/workflows/deploy.yml uses it; acme/billing doesn't have it, and keypin.toml doesn't publish it there. Add the TOML below
  RESEND_API_KEY: wrangler.toml requires it; the Worker billing-worker doesn't have it, and keypin.toml doesn't publish it there. Add the TOML below
`);
    expect(text).toContain(
      "  .env sets DATABASE_URL, RESEND_API_KEY, which keypin.toml doesn't map; a plain setting can stay, and for a key run keypin import .env NAME... --vault <vault> --account <1Password sign-in address>\n",
    );
    expect(text).not.toContain("GITHUB_TOKEN");
    expect(text).not.toContain("REGION");
    expect(added(text)).toBe(`[1password]
account = "<1Password sign-in address>"

[keys.STRIPE_API_KEY]
rotate_every = "90d"

[keys.STRIPE_API_KEY.prod]
from = "op://<vault>/<item>/<field>"

[[keys.STRIPE_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"

[keys.RESEND_API_KEY]
rotate_every = "90d"

[keys.RESEND_API_KEY.prod]
from = "op://<vault>/<item>/<field>"

[[keys.RESEND_API_KEY.prod.publish]]
to = "cloudflare-worker"
account = "${ACCOUNT}"
worker = "billing-worker"
`);
    run.unchanged();
    expect(leaks(...run.everything())).toBe(false);
  });

  test("the TOML to add, filled in and pasted, closes the production gap", async () => {
    const first = setup({ files: { [MAP]: TEMPLATE } });
    await cli(["check"], first.deps);
    const pasted = `${TEMPLATE}\n${fill(added(first.stdout.text))}`;
    assert(parseMap(pasted, MAP).ok, pasted);

    const run = setup({
      files: { [MAP]: pasted },
      github: { ok: true, secrets: [{ name: "STRIPE_API_KEY", updatedAt: null }] },
      worker: { ok: true, secrets: [{ name: "RESEND_API_KEY", updatedAt: null }] },
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = json(run.stdout.text);
    expect(data.add).toBeNull();
    expect(data.production).toEqual([
      {
        name: "STRIPE_API_KEY",
        to: "github-actions",
        place: "acme/billing",
        usedBy: [".github/workflows/deploy.yml"],
        mapped: "prod",
        holds: true,
        ok: true,
      },
      {
        name: "RESEND_API_KEY",
        to: "cloudflare-worker",
        place: "the Worker billing-worker",
        usedBy: ["wrangler.toml"],
        mapped: "prod",
        holds: true,
        ok: true,
      },
    ]);
    expect(data.problems).toEqual([
      ".env sets RESEND_API_KEY, which keypin.toml maps with no dev entry; run keypin import .env NAME... --vault <vault> to add one",
    ]);
    expect(data.notes).toContain(
      ".env sets DATABASE_URL, which keypin.toml doesn't map; a plain setting can stay, and for a key run keypin import .env NAME... --vault <vault>",
    );
  });

  test("a plain setting left in an env file is a note, and check still exits 0", async () => {
    const run = setup({
      files: { [MAP]: PUBLISHED, [`${ROOT}/.env`]: `PORT=3000\n` },
      github: { ok: true, secrets: [{ name: "STRIPE_API_KEY", updatedAt: null }] },
      worker: { ok: true, secrets: [{ name: "RESEND_API_KEY", updatedAt: null }] },
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(0);
    const data = json(run.stdout.text);
    expect(data.problems).toEqual([]);
    expect(data.local).toEqual([
      { file: ".env", tracked: false, unmapped: ["PORT"], elsewhere: [] },
    ]);
    expect(data.notes).toContain(
      ".env sets PORT, which keypin.toml doesn't map; a plain setting can stay, and for a key run keypin import .env NAME... --vault <vault>",
    );
  });

  test("the TOML to add, pasted unfilled, fails with one line per <...> until replaced", async () => {
    const first = setup({ files: { [MAP]: TEMPLATE } });
    await cli(["check"], first.deps);
    const run = setup({ files: { [MAP]: `${TEMPLATE}\n${added(first.stdout.text)}` } });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = json(run.stdout.text);
    expect(data.problems.length).toBeGreaterThanOrEqual(3);
    for (const problem of data.problems) expect(String(problem)).toContain("<...> placeholder");
    expect(run.vault).toEqual([]);
  });

  test("with no keypin.toml at all, check still reports the project", async () => {
    const run = setup({ files: { [REGISTRY]: registryWith() } });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = json(run.stdout.text);
    expect(data.map).toBeNull();
    expect(data.problems[0]).toBe(
      `no keypin.toml in ${ROOT} or any folder above it; run keypin init, then keypin check again`,
    );
    expect(data.problems).toHaveLength(3);
    expect(typeof data.add).toBe("string");
    expect(run.vault).toEqual([]);
    expect(run.disk.contents.has(MAP)).toBe(false);
  });

  test("a finished setup checks items by ID, without reading a value, and exits 0", async () => {
    const run = setup({
      files: { [MAP]: PUBLISHED, [`${ROOT}/.env`]: null },
      github: { ok: true, secrets: [{ name: "STRIPE_API_KEY", updatedAt: null }] },
      worker: { ok: true, secrets: [{ name: "RESEND_API_KEY", updatedAt: null }] },
    });
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.vault.every((call) => call.startsWith("ids "))).toBe(true);
    expect(run.vault).toHaveLength(4);
    expect(run.stderr.text).toContain("keypin: reading the item IDs, not the values, from");
    const text = run.stdout.text;
    expect(text).toContain(
      "  ok     STRIPE_API_KEY in acme/billing (.github/workflows/deploy.yml): has it, keypin.toml (prod)",
    );
    expect(text).toContain("Everything checks out.");
    expect(text).not.toContain("Add to");
    run.unchanged();
    expect(leaks(...run.everything())).toBe(false);
  });

  test("a mapped secret the place doesn't have yet says to publish it", async () => {
    const run = setup({ files: { [MAP]: PUBLISHED, [`${ROOT}/.env`]: null } });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = json(run.stdout.text);
    expect(data.problems).toEqual([
      "STRIPE_API_KEY: keypin.toml publishes it to acme/billing, which doesn't have it yet; run keypin publish STRIPE_API_KEY",
      "RESEND_API_KEY: keypin.toml publishes it to the Worker billing-worker, which doesn't have it yet; run keypin publish RESEND_API_KEY",
    ]);
    expect(data.add).toBeNull();
  });

  test("a secret the place has, which the map doesn't publish there, gets the TOML to add", async () => {
    const run = setup({
      files: { [MAP]: MAPPED, [`${ROOT}/.env`]: null },
      github: { ok: true, secrets: [{ name: "STRIPE_API_KEY", updatedAt: null }] },
      worker: { ok: true, secrets: [{ name: "RESEND_API_KEY", updatedAt: null }] },
    });
    expect(await cli(["check"], run.deps)).toBe(1);
    const text = run.stdout.text;
    expect(text).toContain(
      "STRIPE_API_KEY: .github/workflows/deploy.yml uses it; acme/billing has it, but keypin.toml doesn't publish it there. Add the TOML below",
    );
    const toml = added(text);
    expect(toml).not.toContain("[1password]");
    expect(toml).not.toContain("[keys.RESEND_API_KEY]\n");
    expect(toml).toContain(`[keys.RESEND_API_KEY.prod]
from = "op://<vault>/<item>/<field>"

[[keys.RESEND_API_KEY.prod.publish]]
to = "cloudflare-worker"`);
    assert(parseMap(`${MAPPED}\n${fill(toml)}`, MAP).ok);
  });

  test("a key whose prod table is inline gets an entry for its publish list instead", async () => {
    const map = `[1password]
account = "my.1password.com"

[keys.STRIPE_API_KEY]
rotate_every = "90d"
prod = { from = "op://Private/billing prod stripe api key/password", publish = [
  { to = "cloudflare-worker", account = "${ACCOUNT}", worker = "billing-worker" },
] }
`;
    const run = setup({
      files: { [MAP]: map, [`${ROOT}/.env`]: null, [`${ROOT}/wrangler.toml`]: null },
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = json(run.stdout.text);
    expect(data.problems).toEqual([
      'STRIPE_API_KEY: .github/workflows/deploy.yml uses it; acme/billing doesn\'t have it, and keypin.toml doesn\'t publish it there. Add { to = "github-actions", repo = "acme/billing" } to the publish list of prod in [keys.STRIPE_API_KEY] in keypin.toml',
    ]);
    expect(data.add).toBeNull();
  });

  test("a key whose prod entry is a bare reference gets the table to replace it with", async () => {
    const ref = "op://Private/billing prod stripe api key/password";
    const map = `[1password]
account = "my.1password.com"

[keys.STRIPE_API_KEY]
rotate_every = "90d"
prod = "${ref}"
`;
    const run = setup({
      files: { [MAP]: map, [`${ROOT}/.env`]: null, [`${ROOT}/wrangler.toml`]: null },
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = json(run.stdout.text);
    const replaced = `prod = { from = "${ref}", publish = [{ to = "github-actions", repo = "acme/billing" }] }`;
    expect(data.problems).toEqual([
      `STRIPE_API_KEY: .github/workflows/deploy.yml uses it; acme/billing doesn't have it, and keypin.toml doesn't publish it there. In [keys.STRIPE_API_KEY] in keypin.toml, replace prod = "${ref}" with ${replaced}`,
    ]);
    expect(data.add).toBeNull();
    const edited = map.replace(`prod = "${ref}"`, replaced);
    const parsed = parseMap(edited, MAP);
    assert(parsed.ok);
    expect(parsed.map.keys[0]?.environments.prod?.publish).toEqual([
      { to: "github-actions", repo: "acme/billing", account: "acme" },
    ]);
  });

  test("a key whose prod entry is an inline table without a publish list gets the entry to replace it with", async () => {
    const ref = "op://Private/billing prod stripe api key/password";
    const entry = `prod = { from = "${ref}" }`;
    const map = `[1password]
account = "my.1password.com"

[keys.STRIPE_API_KEY]
rotate_every = "90d"
${entry}
`;
    const run = setup({
      files: { [MAP]: map, [`${ROOT}/.env`]: null, [`${ROOT}/wrangler.toml`]: null },
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = json(run.stdout.text);
    const replaced = `prod = { from = "${ref}", publish = [{ to = "github-actions", repo = "acme/billing" }] }`;
    expect(data.problems).toEqual([
      `STRIPE_API_KEY: .github/workflows/deploy.yml uses it; acme/billing doesn't have it, and keypin.toml doesn't publish it there. In [keys.STRIPE_API_KEY] in keypin.toml, replace the prod entry with ${replaced}`,
    ]);
    const parsed = parseMap(map.replace(entry, replaced), MAP);
    assert(parsed.ok);
    expect(parsed.map.keys[0]?.environments.prod?.publish).toEqual([
      { to: "github-actions", repo: "acme/billing", account: "acme" },
    ]);
  });

  test("a lowercase map key gets publish commands in its own spelling", async () => {
    const map = `[1password]
account = "my.1password.com"

[keys.stripe_api_key]
rotate_every = "90d"

[keys.stripe_api_key.prod]
from = "op://Private/billing prod stripe api key/password"

[[keys.stripe_api_key.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;
    const run = setup({
      files: { [MAP]: map, [`${ROOT}/.env`]: null, [`${ROOT}/wrangler.toml`]: null },
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    expect(json(run.stdout.text).problems).toEqual([
      "STRIPE_API_KEY: keypin.toml publishes it to acme/billing, which doesn't have it yet; run keypin publish stripe_api_key",
    ]);
  });

  test("the same Worker name in two accounts is two places", async () => {
    const other = "22222222222222222222222222222222";
    const map = `${MAPPED}
[keys.RESEND_API_KEY.prod]
from = "op://Private/billing prod resend api key/password"

[[keys.RESEND_API_KEY.prod.publish]]
to = "cloudflare-worker"
account = "${ACCOUNT}"
worker = "billing-worker"
`;
    const run = setup({
      files: {
        [MAP]: map,
        [`${ROOT}/.env`]: null,
        [`${ROOT}/.github/workflows/deploy.yml`]: null,
        [`${ROOT}/staging/wrangler.toml`]: `name = "billing-worker"\naccount_id = "${other}"\n\n[secrets]\nrequired = ["RESEND_API_KEY"]\n`,
      },
      deps: {
        workerSecrets: async (account) => ({
          ok: true,
          secrets: account === ACCOUNT ? [{ name: "RESEND_API_KEY", updatedAt: null }] : [],
        }),
      },
    });
    run.disk.folders.add(`${ROOT}/staging`);
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = json(run.stdout.text);
    expect(data.production).toEqual([
      expect.objectContaining({
        place: `the Worker billing-worker in account ${other}`,
        usedBy: ["staging/wrangler.toml"],
        mapped: null,
        holds: false,
      }),
      expect.objectContaining({
        place: `the Worker billing-worker in account ${ACCOUNT}`,
        usedBy: ["wrangler.toml"],
        mapped: "prod",
        holds: true,
        ok: true,
      }),
    ]);
    expect(data.add).toBeNull();
    expect(data.problems).toEqual([
      expect.stringContaining(
        `keypin.toml can't publish RESEND_API_KEY to two Workers named billing-worker from one environment (accounts ${ACCOUNT} and ${other}); publish one of them from another environment, listed in environments`,
      ),
    ]);
    expect(parseMap(map, MAP).ok).toBe(true);
  });

  test("two unnamed Workers that need one secret each get their own TOML", async () => {
    const run = setup({
      files: {
        [MAP]: MAPPED,
        [`${ROOT}/.env`]: null,
        [`${ROOT}/.github/workflows/deploy.yml`]: null,
        [`${ROOT}/wrangler.toml`]: `[secrets]\nrequired = ["RESEND_API_KEY"]\n`,
        [`${ROOT}/staging/wrangler.toml`]: `[secrets]\nrequired = ["RESEND_API_KEY"]\n`,
      },
    });
    run.disk.folders.add(`${ROOT}/staging`);
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = json(run.stdout.text);
    assert(typeof data.add === "string");
    expect(data.add.match(/worker = "<Worker name>"/g)).toHaveLength(2);
    expect(JSON.stringify(data.problems)).not.toContain("can't publish");
  });

  test("two accounts' Workers with one name, neither mapped, get TOML that parses", async () => {
    const other = "22222222222222222222222222222222";
    const run = setup({
      files: {
        [MAP]: MAPPED,
        [`${ROOT}/.env`]: null,
        [`${ROOT}/.github/workflows/deploy.yml`]: null,
        [`${ROOT}/staging/wrangler.toml`]: `name = "billing-worker"\naccount_id = "${other}"\n\n[secrets]\nrequired = ["RESEND_API_KEY"]\n`,
      },
    });
    run.disk.folders.add(`${ROOT}/staging`);
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = json(run.stdout.text);
    assert(typeof data.add === "string");
    expect(data.add.match(/worker = "billing-worker"/g)).toHaveLength(1);
    expect(data.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("can't publish RESEND_API_KEY to two Workers named billing-worker"),
      ]),
    );
    const filled = `${MAPPED}\n${data.add.replaceAll("<vault>/<item>/<field>", "Private/billing prod resend api key/password")}`;
    const parsed = parseMap(filled, MAP);
    assert(parsed.ok, parsed.ok ? "" : parsed.errors.join("\n"));
  });

  test("an unreadable repo or Worker is unknown, never missing", async () => {
    const run = setup({
      files: { [MAP]: PUBLISHED, [`${ROOT}/.env`]: null },
      github: { ok: false, reason: "HTTP 403" },
      worker: new Error("the wrangler login has expired; run `wrangler whoami`"),
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(0);
    const data = json(run.stdout.text);
    expect(data.unknown).toEqual([
      {
        what: "the secrets of the Worker billing-worker",
        reason: "the wrangler login has expired; run `wrangler whoami`",
      },
      {
        what: "the Actions secrets of acme/billing",
        reason: "as the active gh login: HTTP 403",
      },
    ]);
    expect(JSON.stringify(data.production)).toContain('"holds":null');
  });

  test("fills in only what keypin knows, and leaves <...> for the rest", async () => {
    const run = setup({
      files: {
        [MAP]: TEMPLATE,
        [`${ROOT}/wrangler.toml`]: `[secrets]\nrequired = ["RESEND_API_KEY"]\n`,
      },
      git: { "remote get-url origin": "https://gitlab.com/acme/billing.git\n" },
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = json(run.stdout.text);
    expect(data.add).toContain('repo = "<owner>/<repo>"');
    expect(data.add).toContain('account = "<Cloudflare account ID>"\nworker = "<Worker name>"');
    expect(data.unknown).toEqual([
      {
        what: "the secrets of the Worker in wrangler.toml",
        reason: "wrangler.toml names no Worker",
      },
      {
        what: "the GitHub repository's Actions secrets",
        reason: "the origin remote isn't on github.com",
      },
    ]);
    expect(run.calls.some((c) => c.startsWith("github") || c.startsWith("worker"))).toBe(false);
  });

  test("a tracked env file is a problem", async () => {
    const run = setup({ files: { [MAP]: MAPPED }, git: { "ls-files": ".env\0" } });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    expect(json(run.stdout.text).problems).toContain(
      ".env is tracked by git, so its values may be committed",
    );
  });

  test("a workflow job's environment may hold the secret, and check says so", async () => {
    const run = setup({
      files: {
        [MAP]: MAPPED,
        [`${ROOT}/.github/workflows/deploy.yml`]: `
on: push
jobs:
  deploy:
    environment: production
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ secrets.STRIPE_API_KEY }}
`,
      },
    });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(
      "acme/billing doesn't have it as a repo secret (it may be a secret of the environment production, which check doesn't read)",
    );
  });

  test("skips dependency folders and nested git repositories, and says which", async () => {
    const run = setup({
      files: {
        [MAP]: MAPPED,
        [`${ROOT}/node_modules/pkg/.env`]: `IGNORED=${SENTINEL}\n`,
        [`${ROOT}/nested/.git/HEAD`]: "ref: refs/heads/main\n",
        [`${ROOT}/nested/.env`]: `NESTED=${SENTINEL}\n`,
        [`${ROOT}/web/.env.local`]: `VITE_KEY=${SENTINEL}\n`,
      },
    });
    for (const folder of ["node_modules", "node_modules/pkg", "nested", "nested/.git", "web"])
      run.disk.folders.add(`${ROOT}/${folder}`);
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = json(run.stdout.text);
    expect(data.read).toEqual({
      env: [".env", ".env.example", "web/.env.local"],
      wrangler: ["wrangler.toml"],
      workflows: [".github/workflows/deploy.yml"],
      notScanned: ["nested"],
    });
    expect(data.notes).toContain(
      "web/.env.local sets VITE_KEY, which keypin.toml doesn't map; a plain setting can stay, and for a key run keypin import web/.env.local NAME... --vault <vault>",
    );
    expect(run.stdout.text).not.toContain("IGNORED");
    expect(run.stdout.text).not.toContain("NESTED");
  });

  test("an unreadable folder or file is unknown, and the rest of the report still prints", async () => {
    const denied = (path: string) =>
      Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES" });
    const run = setup({
      files: {
        [MAP]: PUBLISHED,
        [`${ROOT}/private/data.bin`]: "x",
        [`${ROOT}/web/.env.local`]: `VITE_KEY=${SENTINEL}\n`,
      },
      github: { ok: true, secrets: [{ name: "STRIPE_API_KEY", updatedAt: null }] },
      worker: { ok: true, secrets: [{ name: "RESEND_API_KEY", updatedAt: null }] },
    });
    for (const folder of ["private", "web"]) run.disk.folders.add(`${ROOT}/${folder}`);
    const listFolder = run.deps.listFolder.bind(run.deps);
    const read = run.deps.files.read.bind(run.deps.files);
    run.deps.listFolder = async (path) => {
      if (path === `${ROOT}/private`) throw denied(path);
      return listFolder(path);
    };
    run.deps.files = {
      ...run.deps.files,
      read: async (path) => {
        if (path === `${ROOT}/web/.env.local`) throw denied(path);
        return read(path);
      },
    };
    expect(await cli(["check", "--json"], run.deps)).toBe(0);
    const data = json(run.stdout.text);
    expect(data.unknown).toEqual([
      {
        what: "the env files and wrangler configs in private",
        reason: `it couldn't be read: EACCES: permission denied, open '${ROOT}/private'`,
      },
      {
        what: "the names in web/.env.local",
        reason: `it couldn't be read: EACCES: permission denied, open '${ROOT}/web/.env.local'`,
      },
    ]);
    expect(data.production).toHaveLength(2);
    expect(run.vault).toHaveLength(4);
  });

  test("a workflow that passes secrets on is unknown, and check reads the repo's secrets", async () => {
    const run = setup({
      files: {
        [MAP]: MAPPED,
        [`${ROOT}/.env`]: null,
        [`${ROOT}/wrangler.toml`]: null,
        [`${ROOT}/.github/workflows/deploy.yml`]: `
on: push
jobs:
  deploy:
    uses: ./.github/workflows/reusable.yml
    secrets: inherit
`,
      },
      github: {
        ok: true,
        secrets: [
          { name: "STRIPE_API_KEY", updatedAt: null },
          { name: "RESEND_API_KEY", updatedAt: null },
        ],
      },
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(0);
    expect(run.calls).toContain("github acme/billing as null");
    const data = json(run.stdout.text);
    expect(data.unknown).toEqual([
      {
        what: "every secret .github/workflows/deploy.yml uses",
        reason:
          "it passes secrets on (secrets: inherit or toJSON(secrets)), so check can't tell which",
      },
    ]);
    expect(data.notes).toContain(
      "acme/billing has STRIPE_API_KEY, RESEND_API_KEY, which no workflow names and keypin.toml doesn't publish there; a workflow that passes secrets on may use them",
    );
  });

  test("Worker list entries with text or key material never reach the output", async () => {
    const reader = new CloudflareReader({
      token: async () => "token",
      fetch: async (url) => {
        const path = new URL(url).pathname;
        const body = path.endsWith("/accounts")
          ? { result: [{ id: ACCOUNT }], result_info: { total_pages: 1 } }
          : path.endsWith("/secrets")
            ? {
                result: [
                  { name: "RESEND_API_KEY", type: "secret_text", text: SENTINEL },
                  { name: "SIGNING", type: "secret_key", key_base64: SENTINEL, algorithm: {} },
                ],
              }
            : { errors: [{ message: SENTINEL }] };
        return new Response(JSON.stringify(body), { status: path.endsWith("/user") ? 500 : 200 });
      },
    });
    for (const flag of [[], ["--json"]]) {
      const run = setup({
        files: { [MAP]: MAPPED },
        deps: { workerSecrets: (account, worker) => reader.listWorkerSecrets(account, worker) },
      });
      await cli(["check", ...flag], run.deps);
      expect(run.stdout.text).toContain(
        flag.length
          ? '"place": "the Worker billing-worker",\n      "usedBy": [\n        "wrangler.toml"\n      ],\n      "mapped": null,\n      "holds": true'
          : "RESEND_API_KEY in the Worker billing-worker (wrangler.toml): has it, not in keypin.toml",
      );
      expect(leaks(...run.everything())).toBe(false);
    }
  });
});
