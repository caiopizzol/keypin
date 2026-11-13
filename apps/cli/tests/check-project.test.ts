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
      ".env sets RESEND_API_KEY, which keypin.toml maps with no dev entry; for a key run keypin import .env RESEND_API_KEY --vault <vault>",
    ]);
    expect(data.notes).toContain(
      ".env sets DATABASE_URL, which keypin.toml doesn't map; a plain setting can stay, and for a key run keypin import .env NAME... --vault <vault>",
    );
  });

  test("an env file named for an environment suggests importing it with --env", async () => {
    const run = setup({
      files: {
        [MAP]: MAPPED,
        [`${ROOT}/.env.prod`]: `DATABASE_URL=${SENTINEL}\nSTRIPE_API_KEY=${SENTINEL}\n`,
        [`${ROOT}/.dev.vars.prod`]: `RESEND_API_KEY=${SENTINEL}\n`,
        [`${ROOT}/.env.production`]: `OTHER_KEY=${SENTINEL}\n`,
      },
    });
    await cli(["check", "--json"], run.deps);
    const data = json(run.stdout.text);
    expect(data.notes).toContain(
      ".env.prod sets STRIPE_API_KEY, which keypin.toml doesn't map; a plain setting can stay, and for a key run keypin import .env.prod NAME... --env prod --vault <vault>",
    );
    expect(data.problems).toContain(
      ".env.prod sets DATABASE_URL, which keypin.toml maps with no prod entry; for a key run keypin import .env.prod DATABASE_URL --env prod --vault <vault>",
    );
    expect(data.problems).toContain(
      ".dev.vars.prod sets RESEND_API_KEY, which keypin.toml maps with no prod entry; for a key run keypin import .dev.vars.prod RESEND_API_KEY --env prod --vault <vault>",
    );
    expect(data.notes).toContain(
      ".env.production sets OTHER_KEY, which keypin.toml doesn't map; a plain setting can stay, and for a key run keypin import .env.production NAME... --vault <vault>, which maps them as dev; if they're the values of another environment, list it in environments and add --env <name>",
    );
    expect(leaks(...run.everything())).toBe(false);
  });

  test("an env file named for an environment the map doesn't list says it would import as the first", async () => {
    const note =
      ", which maps them as dev; if they're the values of another environment, list it in environments and add --env <name>";
    const mapped = setup({
      files: {
        [MAP]: MAPPED,
        [`${ROOT}/.env.production`]: `DATABASE_URL=${SENTINEL}\nNEW_KEY=${SENTINEL}\n`,
      },
    });
    await cli(["check", "--json"], mapped.deps);
    const data = json(mapped.stdout.text);
    expect(data.notes).toContain(
      `.env.production sets NEW_KEY, which keypin.toml doesn't map; a plain setting can stay, and for a key run keypin import .env.production NAME... --vault <vault>${note}`,
    );

    const first = setup({
      files: {
        [MAP]: `environments = ["production", "staging"]\n${MAPPED.replaceAll("dev =", "production =")}`,
        [`${ROOT}/.env.production`]: `NEW_KEY=${SENTINEL}\n`,
      },
    });
    await cli(["check", "--json"], first.deps);
    const listed = json(first.stdout.text);
    expect(JSON.stringify(listed.notes)).not.toContain("which maps them as");
    expect(listed.notes).toContain(
      ".env.production sets NEW_KEY, which keypin.toml doesn't map; a plain setting can stay, and for a key run keypin import .env.production NAME... --vault <vault>",
    );
    expect(leaks(...mapped.everything(), ...first.everything())).toBe(false);
  });

  test("an env file named for an unlisted environment flags an already-mapped key too", async () => {
    const run = setup({
      files: {
        [MAP]: `environments = ["dev", "staging", "prod"]\n${MAPPED.replace(
          'dev = "op://Private/billing dev database url/password"',
          'staging = "op://Private/billing staging database url/password"',
        )}`,
        [`${ROOT}/.env.production`]: `DATABASE_URL=${SENTINEL}\n`,
      },
    });
    await cli(["check", "--json"], run.deps);
    expect(json(run.stdout.text).problems).toContain(
      ".env.production sets DATABASE_URL, which keypin.toml maps with no dev entry; for a key run keypin import .env.production DATABASE_URL --vault <vault>, which maps them as dev; if they're the values of another environment, list it in environments and add --env <name>",
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
    expect(run.stderr.text).toContain("Looked up 4 items in 1Password account");
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

  describe("a wrangler env's Worker", () => {
    const STAGED = `name = "billing-worker"
account_id = "${ACCOUNT}"

[secrets]
required = ["RESEND_API_KEY"]

[env.staging]
name = "billing-worker-staging"

[env.staging.secrets]
required = ["RESEND_API_KEY"]
`;
    const files = (map: string, wrangler = STAGED) => ({
      [MAP]: map,
      [`${ROOT}/.env`]: null,
      [`${ROOT}/.github/workflows/deploy.yml`]: null,
      [`${ROOT}/wrangler.toml`]: wrangler,
    });
    const both = (
      environments: string,
      staging: string,
      prod = "prod",
    ) => `environments = ${environments}
${MAPPED}
[keys.RESEND_API_KEY.${prod}]
from = "op://Private/billing prod resend api key/password"

[[keys.RESEND_API_KEY.${prod}.publish]]
to = "cloudflare-worker"
account = "${ACCOUNT}"
worker = "billing-worker"

[keys.RESEND_API_KEY.${staging}]
from = "op://Private/billing prod item/password"

[[keys.RESEND_API_KEY.${staging}.publish]]
to = "cloudflare-worker"
account = "${ACCOUNT}"
worker = "billing-worker-staging"
`;
    const held = { ok: true as const, secrets: [{ name: "RESEND_API_KEY", updatedAt: null }] };

    test("is proposed under the keypin environment of the same name, with the line to list it", async () => {
      const run = setup({ files: files(MAPPED) });
      expect(await cli(["check", "--json"], run.deps)).toBe(1);
      const data = json(run.stdout.text);
      assert(typeof data.add === "string");
      expect(data.add).toContain(`[[keys.RESEND_API_KEY.prod.publish]]
to = "cloudflare-worker"
account = "${ACCOUNT}"
worker = "billing-worker"`);
      expect(data.add).toContain(`[[keys.RESEND_API_KEY.staging.publish]]
to = "cloudflare-worker"
account = "${ACCOUNT}"
worker = "billing-worker-staging"`);
      expect(data.add.match(/worker = /g)).toHaveLength(2);
      const line = 'environments = ["dev", "staging", "prod"]';
      expect(data.problems).toContain(
        `keypin.toml has no environment for the wrangler env staging; add at the top of keypin.toml: ${line} (keypin run uses the first, keypin publish the last)`,
      );
      const parsed = parseMap(`${line}\n${MAPPED}\n${fill(data.add)}`, MAP);
      assert(parsed.ok, parsed.ok ? "" : parsed.errors.join("\n"));
      const staging = parsed.map.keys.find((k) => k.name === "RESEND_API_KEY")?.environments;
      expect(staging?.prod?.publish).toEqual([
        { to: "cloudflare-worker", account: ACCOUNT, worker: "billing-worker" },
      ]);
      expect(staging?.staging?.publish).toEqual([
        { to: "cloudflare-worker", account: ACCOUNT, worker: "billing-worker-staging" },
      ]);
      run.unchanged();
    });

    test("never moves a sole environment from first place", async () => {
      const run = setup({
        files: files(`environments = ["dev"]\n${MAPPED}`),
      });
      expect(await cli(["check", "--json"], run.deps)).toBe(1);
      expect(json(run.stdout.text).problems).toContainEqual(
        expect.stringContaining(
          'replace the environments line in keypin.toml with: environments = ["dev", "staging"]',
        ),
      );
    });

    test("keeps the map's order and puts a new environment before the last", async () => {
      const run = setup({
        files: files(`environments = ["local", "live"]\n${MAPPED.replaceAll("dev =", "local =")}`),
      });
      expect(await cli(["check", "--json"], run.deps)).toBe(1);
      expect(json(run.stdout.text).problems).toContain(
        `keypin.toml has no environment for the wrangler env staging; replace the environments line in keypin.toml with: environments = ["local", "staging", "live"] (keypin run uses the first, keypin publish the last)`,
      );
    });

    test("published from its environment is covered, and never by a prod entry", async () => {
      const run = setup({
        files: files(both(`["dev", "staging", "prod"]`, "staging")),
        worker: held,
      });
      expect(await cli(["check", "--json"], run.deps)).toBe(0);
      const data = json(run.stdout.text);
      expect(data.production).toEqual([
        expect.objectContaining({ place: "the Worker billing-worker", mapped: "prod", ok: true }),
        expect.objectContaining({
          place: "the Worker billing-worker-staging",
          mapped: "staging",
          ok: true,
        }),
      ]);
      expect(data.problems).toEqual([]);

      const wrong = setup({
        files: files(both(`["dev", "staging", "prod"]`, "prod", "staging")),
        worker: held,
      });
      expect(await cli(["check", "--json"], wrong.deps)).toBe(1);
      const swapped = json(wrong.stdout.text);
      expect(swapped.production).toEqual([
        expect.objectContaining({
          place: "the Worker billing-worker",
          mapped: "staging",
          ok: true,
        }),
        expect.objectContaining({
          place: "the Worker billing-worker-staging",
          mapped: null,
          ok: false,
        }),
      ]);
      expect(swapped.add).toBeNull();
      expect(swapped.problems).toEqual([
        "RESEND_API_KEY: wrangler.toml requires it; keypin.toml publishes it to the Worker billing-worker-staging from prod, but that Worker is the wrangler env staging, so it would get the prod value; move that publish entry to staging",
      ]);
    });

    test.each(["staging", "zcopy"])(
      "declared again on its own (in %s/), keeps its environment whichever config is read first",
      async (folder) => {
        const run = setup({
          files: {
            ...files(both(`["dev", "staging", "prod"]`, "prod", "staging")),
            [`${ROOT}/${folder}/wrangler.toml`]: `name = "billing-worker-staging"\naccount_id = "${ACCOUNT}"\n\n[secrets]\nrequired = ["RESEND_API_KEY"]\n`,
          },
          worker: held,
        });
        run.disk.folders.add(`${ROOT}/${folder}`);
        expect(await cli(["check", "--json"], run.deps)).toBe(1);
        const data = json(run.stdout.text);
        expect(data.production).toContainEqual(
          expect.objectContaining({
            place: "the Worker billing-worker-staging",
            mapped: null,
            ok: false,
          }),
        );
        expect(data.problems).toContainEqual(
          expect.stringContaining(
            "publishes it to the Worker billing-worker-staging from prod, but that Worker is the wrangler env staging",
          ),
        );
      },
    );

    test.each([
      ["prod", "staging"],
      ["staging", "prod"],
    ])(
      "named by two wrangler envs (%s first) is accepted from either, with a note",
      async (first, second) => {
        const wrangler = `account_id = "${ACCOUNT}"

[env.${first}]
name = "billing-worker"
[env.${first}.secrets]
required = ["RESEND_API_KEY"]

[env.${second}]
name = "billing-worker"
[env.${second}.secrets]
required = ["RESEND_API_KEY"]
`;
        const map = `environments = ["dev", "staging", "prod"]
${MAPPED}
[keys.RESEND_API_KEY.staging]
from = "op://Private/billing prod item/password"

[[keys.RESEND_API_KEY.staging.publish]]
to = "cloudflare-worker"
account = "${ACCOUNT}"
worker = "billing-worker"
`;
        const run = setup({ files: files(map, wrangler), worker: held });
        expect(await cli(["check", "--json"], run.deps)).toBe(0);
        const data = json(run.stdout.text);
        expect(data.production).toEqual([
          expect.objectContaining({
            place: "the Worker billing-worker",
            mapped: "staging",
            ok: true,
          }),
        ]);
        expect(data.notes).toContain(
          "the Worker billing-worker is declared by the wrangler envs prod and staging; it holds one value, so check accepts it from any of them. Give each env its own Worker name to check them apart",
        );
      },
    );

    test("named by two wrangler envs is never accepted from a third environment", async () => {
      const wrangler = `account_id = "${ACCOUNT}"

[env.prod]
name = "billing-worker"
[env.prod.secrets]
required = ["RESEND_API_KEY"]

[env.staging]
name = "billing-worker"
[env.staging.secrets]
required = ["RESEND_API_KEY"]
`;
      const map = `environments = ["dev", "staging", "prod"]
[1password]
account = "my.1password.com"

[keys.RESEND_API_KEY.dev]
from = "op://Private/billing prod item/password"

[[keys.RESEND_API_KEY.dev.publish]]
to = "cloudflare-worker"
account = "${ACCOUNT}"
worker = "billing-worker"
`;
      const run = setup({ files: files(map, wrangler), worker: held });
      expect(await cli(["check", "--json"], run.deps)).toBe(1);
      const data = json(run.stdout.text);
      expect(data.production).toEqual([
        expect.objectContaining({ place: "the Worker billing-worker", mapped: null, ok: false }),
      ]);
      expect(data.problems).toContainEqual(
        expect.stringContaining(
          "publishes it to the Worker billing-worker from dev, but that Worker is the wrangler env prod and staging",
        ),
      );
    });

    test.each([
      ["OTHER_KEY", "RESEND_API_KEY"],
      ["RESEND_API_KEY", "OTHER_KEY"],
    ])(
      "named by two wrangler envs gives the same result whatever the secret order (%s first)",
      async (a, b) => {
        const wrangler = `account_id = "${ACCOUNT}"

[env.prod]
name = "billing-worker"
[env.prod.secrets]
required = ["RESEND_API_KEY"]

[env.staging]
name = "billing-worker"
[env.staging.secrets]
required = ["${a}", "${b}"]
`;
        const map = `environments = ["dev", "staging", "prod"]
[1password]
account = "my.1password.com"

[keys.RESEND_API_KEY.prod]
from = "op://Private/billing prod item/password"

[[keys.RESEND_API_KEY.prod.publish]]
to = "cloudflare-worker"
account = "${ACCOUNT}"
worker = "billing-worker"

[keys.OTHER_KEY.staging]
from = "op://Private/billing prod item/password"

[[keys.OTHER_KEY.staging.publish]]
to = "cloudflare-worker"
account = "${ACCOUNT}"
worker = "billing-worker"
`;
        const both = {
          ok: true as const,
          secrets: [
            { name: "RESEND_API_KEY", updatedAt: null },
            { name: "OTHER_KEY", updatedAt: null },
          ],
        };
        const run = setup({ files: files(map, wrangler), worker: both });
        expect(await cli(["check", "--json"], run.deps)).toBe(0);
        const data = json(run.stdout.text);
        expect(data.problems).toEqual([]);
        expect(data.notes).toContain(
          "the Worker billing-worker is declared by the wrangler envs prod and staging; it holds one value, so check accepts it from any of them. Give each env its own Worker name to check them apart",
        );
      },
    );

    test("that has no routes and no workers.dev URL is local-only, and isn't checked", async () => {
      const wrangler = `${STAGED}
[env.dev]
routes = []
workers_dev = false

[env.dev.secrets]
required = ["RESEND_API_KEY"]
`;
      const run = setup({ files: files(MAPPED, wrangler) });
      expect(await cli(["check", "--json"], run.deps)).toBe(1);
      const data = json(run.stdout.text);
      expect(run.calls.filter((c) => c.startsWith("worker "))).toEqual([
        `worker ${ACCOUNT} billing-worker`,
        `worker ${ACCOUNT} billing-worker-staging`,
      ]);
      expect(JSON.stringify(data)).not.toContain("billing-worker-dev");
      assert(typeof data.add === "string");
      expect(data.add.match(/worker = /g)).toHaveLength(2);
    });

    test("whose env name isn't a keypin environment name stays under the publish environment, with a note", async () => {
      const run = setup({
        files: files(MAPPED, STAGED.replaceAll("env.staging", "env.Staging_EU")),
      });
      expect(await cli(["check", "--json"], run.deps)).toBe(1);
      const data = json(run.stdout.text);
      assert(typeof data.add === "string");
      expect(data.add).not.toContain("Staging_EU]");
      expect(data.add.match(/\[\[keys\.RESEND_API_KEY\.prod\.publish\]\]/g)).toHaveLength(2);
      expect(data.notes).toContain(
        "wrangler.toml env Staging_EU isn't a keypin environment name, so check proposes its Worker under prod; publish it from the environment that holds its value",
      );
      expect(JSON.stringify(data.problems)).not.toContain("environments =");
    });
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

  const ENV_WORKFLOW = (environment: string) => `
on: push
jobs:
  deploy:
    environment: ${environment}
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ secrets.STRIPE_API_KEY }}
`;

  test("a job's environment is read, and the TOML to add publishes there", async () => {
    const run = setup({
      files: {
        [MAP]: MAPPED,
        [`${ROOT}/.github/workflows/deploy.yml`]: ENV_WORKFLOW("production"),
      },
      deps: {
        githubSecrets: async (repo, login, environment) => {
          run.calls.push(`github ${repo} as ${login} in ${environment ?? "the repo"}`);
          return { ok: true, secrets: [] };
        },
      },
    });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.calls).toContain("github acme/billing as null in production");
    expect(run.stdout.text).toContain(
      "STRIPE_API_KEY: .github/workflows/deploy.yml uses it; acme/billing (environment production) doesn't have it, and keypin.toml doesn't publish it there. Add the TOML below",
    );
    expect(added(run.stdout.text)).toContain(`[[keys.STRIPE_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"
environment = "production"
`);
  });

  test("a map that publishes to the job's environment checks that environment's secrets", async () => {
    const map = PUBLISHED.replace(
      'repo = "acme/billing"\n',
      'repo = "acme/billing"\nenvironment = "Production"\n',
    );
    const reads: string[] = [];
    const run = setup({
      files: {
        [MAP]: map,
        [`${ROOT}/.github/workflows/deploy.yml`]: ENV_WORKFLOW("production"),
      },
      worker: { ok: true, secrets: [{ name: "RESEND_API_KEY", updatedAt: null }] },
      deps: {
        githubSecrets: async (_repo, _login, environment) => {
          reads.push(environment ?? "repo");
          return {
            ok: true,
            secrets: environment ? [{ name: "STRIPE_API_KEY", updatedAt: null }] : [],
          };
        },
      },
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(0);
    expect(reads).toEqual(["repo", "production"]);
    const data = json(run.stdout.text);
    expect(data.production).toContainEqual({
      name: "STRIPE_API_KEY",
      to: "github-actions",
      place: "acme/billing (environment production)",
      usedBy: [".github/workflows/deploy.yml"],
      mapped: "prod",
      holds: true,
      ok: true,
    });
    expect(data.keys).toContainEqual(
      expect.objectContaining({
        key: "STRIPE_API_KEY",
        destinations: [
          expect.objectContaining({
            destination: "github-actions:acme/billing/environments/production:STRIPE_API_KEY",
          }),
        ],
      }),
    );
  });

  test("a repo secret a job with an environment can read stays a repo secret", async () => {
    const run = setup({
      files: {
        [MAP]: MAPPED,
        [`${ROOT}/.github/workflows/deploy.yml`]: ENV_WORKFLOW("production"),
      },
      github: { ok: true, secrets: [{ name: "STRIPE_API_KEY", updatedAt: null }] },
    });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(
      "STRIPE_API_KEY: .github/workflows/deploy.yml uses it; acme/billing has it, but keypin.toml doesn't publish it there.",
    );
    expect(added(run.stdout.text)).not.toContain("environment =");
  });

  const JOBS = (...jobs: [string, string | null, string][]) =>
    `on: push\njobs:\n${jobs
      .map(
        ([job, environment, secret]) =>
          `  ${job}:\n${environment === null ? "" : `    environment: ${environment}\n`}    runs-on: ubuntu-latest\n    steps:\n      - run: echo \${{ secrets.${secret} }}\n`,
      )
      .join("")}`;
  const PRODUCTION_ONLY = PUBLISHED.replace(
    'repo = "acme/billing"\n',
    'repo = "acme/billing"\nenvironment = "production"\n',
  );
  const readsBy = (held: Record<string, string[]>, reads: string[]) => ({
    githubSecrets: async (_repo: string, _login: string | null, environment?: string) => {
      reads.push(environment ?? "repo");
      const names = held[environment ?? "repo"] ?? [];
      return { ok: true as const, secrets: names.map((name) => ({ name, updatedAt: null })) };
    },
  });

  test.each([
    ["another environment", "staging"],
    ["no environment", null],
  ])("a secret mapped to one job's environment still fails for a job with %s", async (_, other) => {
    const reads: string[] = [];
    const run = setup({
      files: {
        [MAP]: PRODUCTION_ONLY,
        [`${ROOT}/.github/workflows/deploy.yml`]: JOBS(
          ["deploy", "production", "STRIPE_API_KEY"],
          ["other", other, "STRIPE_API_KEY"],
        ),
      },
      worker: { ok: true, secrets: [{ name: "RESEND_API_KEY", updatedAt: null }] },
      deps: readsBy({ production: ["STRIPE_API_KEY"] }, reads),
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = json(run.stdout.text);
    expect(data.production).toContainEqual(
      expect.objectContaining({ place: "acme/billing (environment production)", ok: true }),
    );
    expect(data.production).toContainEqual(
      expect.objectContaining({ name: "STRIPE_API_KEY", place: "acme/billing", ok: false }),
    );
  });

  test("case variants of one environment are one place", async () => {
    const reads: string[] = [];
    const run = setup({
      files: {
        [MAP]: MAPPED,
        [`${ROOT}/.github/workflows/deploy.yml`]: JOBS(
          ["a", "Production", "STRIPE_API_KEY"],
          ["b", "production", "STRIPE_API_KEY"],
        ),
      },
      deps: readsBy({}, reads),
    });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(reads).toEqual(["repo", "Production"]);
    expect(added(run.stdout.text)).toContain('environment = "Production"');
  });

  test("a repo whose secrets couldn't be read gets no environment suggestion", async () => {
    const run = setup({
      files: {
        [MAP]: MAPPED,
        [`${ROOT}/.github/workflows/deploy.yml`]: ENV_WORKFLOW("production"),
      },
      github: { ok: false, reason: "HTTP 403" },
    });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(added(run.stdout.text)).not.toContain("environment =");
  });

  test("an environment whose jobs use only GITHUB_ secrets isn't read", async () => {
    const reads: string[] = [];
    const run = setup({
      files: {
        [MAP]: MAPPED,
        [`${ROOT}/.github/workflows/deploy.yml`]: JOBS(
          ["test", null, "STRIPE_API_KEY"],
          ["pages", "github-pages", "GITHUB_TOKEN"],
        ),
      },
      deps: readsBy({}, reads),
    });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(reads).toEqual(["repo"]);
  });

  test("a job whose environment is an expression keeps the repo-secret note", async () => {
    const reads: string[] = [];
    const run = setup({
      files: {
        [MAP]: MAPPED,
        [`${ROOT}/.github/workflows/deploy.yml`]: ENV_WORKFLOW("${{ inputs.target }}"),
      },
      deps: readsBy({}, reads),
    });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(reads).toEqual(["repo"]);
    expect(run.stdout.text).toContain(
      "acme/billing doesn't have it as a repo secret (it may be a secret of the environment ${{ inputs.target }}, which check doesn't read)",
    );
    expect(added(run.stdout.text)).not.toContain("environment =");
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

describe("keypin check's prerequisites", () => {
  const prerequisites = (text: string) => json(text).prerequisites;

  test("right after init, lists the gh and wrangler logins and 1Password, without reading the vault", async () => {
    const run = setup({
      files: { [MAP]: TEMPLATE },
      git: { "config --get github.account": "alice\n" },
      deps: { ghLogin: async () => "not logged in" },
    });
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.vault).toEqual([]);
    expect(run.stdout.text).toContain(`Before you start:
  GitHub:     not logged in; run gh auth login --hostname github.com, signing in as alice
  Cloudflare: not logged in; run wrangler login
  1Password:  not checked;   keypin needs the 1Password desktop app, with Settings → Developer → Integrate with other apps selected
`);
  });

  test("an empty project needs only 1Password, and that doesn't fail check", async () => {
    const run = setup({
      files: Object.fromEntries<string | null>([
        ...Object.keys(PROJECT).map((p): [string, null] => [p, null]),
        [MAP, TEMPLATE],
      ]),
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    const data = json(run.stdout.text);
    expect(data.prerequisites).toEqual([
      {
        name: "1Password",
        status: "not checked",
        fix: "keypin needs the 1Password desktop app, with Settings → Developer → Integrate with other apps selected",
      },
    ]);
    expect(data.problems).toEqual([
      `${MAP} maps no keys yet; run keypin import for an env file, and add the TOML below for production`,
    ]);
  });

  test("says to install gh when it isn't on PATH", async () => {
    const run = setup({
      files: { [MAP]: TEMPLATE },
      deps: { ghLogin: async () => "not installed" },
    });
    await cli(["check", "--json"], run.deps);
    expect(prerequisites(run.stdout.text)).toContainEqual({
      name: "GitHub",
      status: "not installed",
      fix: "install gh (https://cli.github.com), then run gh auth login --hostname github.com",
    });
  });

  test("nothing to list once the logins exist and a vault item was read", async () => {
    const wrangler = { wranglerLoginFile: async () => "/home/me/.wrangler/config/default.toml" };
    const run = setup({ files: { [MAP]: MAPPED }, deps: wrangler });
    await cli(["check"], run.deps);
    expect(run.vault.length).toBeGreaterThan(0);
    expect(run.stdout.text).not.toContain("Before you start");
    const again = setup({ files: { [MAP]: MAPPED }, deps: wrangler });
    await cli(["check", "--json"], again.deps);
    expect(prerequisites(again.stdout.text)).toEqual([]);
  });

  test("a 1Password sign-in that fails is reported instead of not checked", async () => {
    const run = setup({
      files: { [MAP]: MAPPED },
      deps: {
        wranglerLoginFile: async () => "/home/me/.wrangler/config/default.toml",
        vault: () => ({
          ...fakeVault().vault,
          itemIds: async () => {
            throw new Error('1Password account "my.1password.com": sign-in failed: no desktop app');
          },
        }),
      },
    });
    expect(await cli(["check", "--json"], run.deps)).toBe(1);
    expect(prerequisites(run.stdout.text)).toEqual([
      {
        name: "1Password",
        status: "sign-in failed",
        fix: "check the 1Password desktop app, with Settings → Developer → Integrate with other apps selected, and that it's unlocked",
      },
    ]);
  });
});
