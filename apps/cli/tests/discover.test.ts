import { assert, describe, expect, test } from "vite-plus/test";
import { isRecord, loadRegistry, parseMap, type StoreRead } from "@keypin/core";
import { CloudflareReader } from "@keypin/destination-cloudflare";
import { cli } from "../src/cli";
import { TEMPLATE } from "../src/commands/init";
import { fakeDeps, leaks, memoryFiles, parseJson, REGISTRY, SENTINEL } from "./fakes";

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
    expect(parsed.map.keys.map((k) => k.name).toSorted()).toEqual([
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
        [`${ROOT}/keypin.toml`]: `[1password]
account = "my.1password.com"

[keys.STRIPE_KEY]
dev = "op://App Secrets/billing dev stripe/password"
`,
      },
    });
    expect(await cli(["discover"], deps)).toBe(0);
    expect(stdout.text).toMatch(/STRIPE_KEY {2}\[local and cloud, mapped\]/);
    const draft = stdout.text.slice(stdout.text.indexOf("# Draft from keypin discover"));
    expect(draft).toContain(`[1password]\naccount = "my.1password.com"`);
    expect(draft).toContain(`"op://App Secrets/billing `);
    expect(draft).not.toContain('env = "STRIPE_KEY"');
    const parsed = parseMap(draft, "draft");
    assert(parsed.ok, JSON.stringify(parsed));
    const items = parsed.map.keys.flatMap((k) =>
      Object.values(k.environments).flatMap((e) => (e ? [e.ref.item] : [])),
    );
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.startsWith("billing "))).toBe(true);
  });

  test("drafts use the map's declared environments, so its key tables copy into that map", async () => {
    const map = `environments = ["local", "production"]

[1password]
account = "my.1password.com"
`;
    const { deps, stdout } = setup({ files: { [`${ROOT}/keypin.toml`]: map } });
    expect(await cli(["discover"], deps)).toBe(0);
    const draft = stdout.text.slice(stdout.text.indexOf("# Draft from keypin discover"));
    expect(draft).not.toMatch(/\.(dev|prod)\]/);
    const tables = draft.slice(draft.indexOf("\n[keys."));
    const parsed = parseMap(`${map}${tables}`, "keypin.toml");
    assert(parsed.ok, JSON.stringify(parsed));
    const names = parsed.map.keys.flatMap((k) => Object.keys(k.environments));
    expect(new Set(names)).toEqual(new Set(["local", "production"]));
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
                  { name: "STRIPE_KEY", type: "secret_text", text: SENTINEL },
                  { name: "SIGNING", type: "secret_key", key_base64: SENTINEL, algorithm: {} },
                ],
              }
            : { errors: [{ message: SENTINEL }] };
        return new Response(JSON.stringify(body), { status: path.endsWith("/user") ? 500 : 200 });
      },
    });
    const { deps, stdout, stderr } = setup();
    deps.workerSecrets = (account, worker) => reader.listWorkerSecrets(account, worker);
    expect(await cli(["discover"], deps)).toBe(0);
    expect(stdout.text).toMatch(/SIGNING {2}\[cloud\]/);
    expect(await cli(["discover", "--json"], deps)).toBe(0);
    expect(leaks(stdout.text, stderr.text)).toBe(false);
  });

  test("an expired wrangler login is unknown, and discover doesn't refresh it", async () => {
    const { deps, stdout } = setup({
      worker: { ok: false, reason: "the wrangler login has expired; run `wrangler whoami`" },
    });
    expect(await cli(["discover"], deps)).toBe(0);
    expect(stdout.text).toContain(
      "Worker secrets of billing (wrangler.jsonc): the wrangler login has expired; run `wrangler whoami`",
    );
  });

  test("no workflows folder means none; an unreadable one is unknown", async () => {
    const none = setup();
    none.disk.folders.delete(`${ROOT}/.github/workflows`);
    none.disk.contents.delete(`${ROOT}/.github/workflows/deploy.yml`);
    expect(await cli(["discover"], none.deps)).toBe(0);
    expect(none.stdout.text).not.toContain("the secrets the workflows use");

    const denied = setup();
    const original = denied.deps;
    const deps = {
      ...original,
      listFolder: async (path: string) => {
        if (path.endsWith(".github/workflows"))
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        return original.listFolder(path);
      },
    };
    expect(await cli(["discover", "web"], deps)).toBe(0);
    expect(denied.stdout.text).toContain(
      "the secrets the workflows use: ../.github/workflows couldn't be read: EACCES",
    );
  });

  test("doesn't run git ls-files when there are no env files", async () => {
    const { deps, disk, calls } = setup();
    const envFiles = Array.from(disk.contents.keys()).filter((path) =>
      /\/(\.env|\.dev\.vars)[^/]*$/.test(path),
    );
    for (const path of envFiles) disk.contents.delete(path);
    expect(await cli(["discover"], deps)).toBe(0);
    expect(calls.some((c) => c.startsWith("git ls-files"))).toBe(false);
    const withFiles = setup();
    expect(await cli(["discover"], withFiles.deps)).toBe(0);
    expect(withFiles.calls.some((c) => c.startsWith("git ls-files"))).toBe(true);
  });

  test("an invalid keypin.toml falls back to the placeholder vault in the draft", async () => {
    const { deps, stdout } = setup({
      files: {
        [`${ROOT}/keypin.toml`]: `[1password]\naccount = "a"\n[keys.X]\n`,
      },
    });
    expect(await cli(["discover"], deps)).toBe(0);
    const draft = stdout.text.slice(stdout.text.indexOf("# Draft from keypin discover"));
    expect(draft).toContain(`account = "<your 1Password account>"`);
    expect(draft).toContain(`"op://<your vault>/billing `);
    assert(parseMap(draft, "draft").ok);
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

describe("keypin discover --write", () => {
  const MAP = `${ROOT}/keypin.toml`;
  const REAL_MAP = `[1password]
account = "my.1password.com"

[keys.STRIPE_KEY]
dev = "op://App Secrets/billing dev stripe/password"
`;

  test("with no keypin.toml, writes the draft, registers the project, and says the references are placeholders", async () => {
    const { deps, disk, stdout, stderr } = setup();
    expect(await cli(["discover", "--write"], deps)).toBe(0);
    const written = disk.contents.get(MAP);
    assert(written !== undefined);
    const parsed = parseMap(written, MAP);
    assert(parsed.ok, JSON.stringify(parsed));
    expect(parsed.map.keys.map((k) => k.name).toSorted()).toEqual([
      "CLOUDFLARE_API_TOKEN",
      "LOCAL_ONLY",
      "OLD_TOKEN",
      "STRIPE_KEY",
      "VITE_KEY",
    ]);
    expect(written).toContain("# Written by keypin discover.");
    expect(written).not.toContain("nothing was written");
    expect(stdout.text).toContain(`written to ${MAP}:`);
    expect(stderr.text).toContain(`keypin: wrote the draft to ${MAP}.`);
    expect(stderr.text).toContain("op:// references are placeholders");
    expect(stderr.text).toContain(`keypin: ${ROOT} is registered (1 project in ${REGISTRY})`);
    expect((await loadRegistry(disk.files, REGISTRY)).projects).toEqual([ROOT]);
    expect(leaks(stdout.text, stderr.text, written, disk.contents.get(REGISTRY) ?? "")).toBe(false);
  });

  test("writes over the untouched keypin init template", async () => {
    const { deps, disk } = setup({ files: { [MAP]: TEMPLATE } });
    expect(await cli(["discover", "--write"], deps)).toBe(0);
    const written = disk.contents.get(MAP);
    assert(written !== undefined && written !== TEMPLATE);
    assert(parseMap(written, MAP).ok);
    expect((await loadRegistry(disk.files, REGISTRY)).projects).toEqual([ROOT]);
  });

  test("refuses a real map: exit 1, the map unchanged, nothing registered", async () => {
    for (const text of [REAL_MAP, `${TEMPLATE}\n# edited\n`]) {
      const { deps, disk, stderr, stdout } = setup({ files: { [MAP]: text } });
      expect(await cli(["discover", "--write"], deps)).toBe(1);
      expect(disk.contents.get(MAP)).toBe(text);
      expect(disk.contents.has(REGISTRY)).toBe(false);
      expect(stderr.text).toContain("already has a map");
      expect(stderr.text).toContain("copy the [keys.*] tables from its draft by hand");
      expect(stdout.text).toBe("");
    }
  });

  test("refuses a keypin.toml that is a symbolic link, writes nothing through it, and registers nothing", async () => {
    const missing = setup();
    missing.disk.links.add(MAP);
    expect(await cli(["discover", "--write"], missing.deps)).toBe(1);
    expect(missing.stderr.text).toContain(`${MAP} is a symbolic link`);
    expect(missing.disk.contents.has(MAP)).toBe(false);
    expect(missing.disk.contents.has(REGISTRY)).toBe(false);

    const template = setup({ files: { [MAP]: TEMPLATE } });
    template.disk.links.add(MAP);
    expect(await cli(["discover", "--write"], template.deps)).toBe(1);
    expect(template.stderr.text).toContain(`${MAP} is a symbolic link`);
    expect(template.disk.contents.get(MAP)).toBe(TEMPLATE);
    expect(template.disk.contents.has(REGISTRY)).toBe(false);
  });

  test("with nothing to draft, writes nothing and registers nothing", async () => {
    const { deps, disk, stderr } = setup({
      files: Object.fromEntries(Object.keys(FILES).map((path) => [path, ""])),
      github: { ok: true, secrets: [] },
      worker: { ok: true, secrets: [] },
    });
    expect(await cli(["discover", "--write"], deps)).toBe(1);
    expect(stderr.text).toContain("there's no draft; nothing was written");
    expect(disk.contents.has(MAP)).toBe(false);
    expect(disk.contents.has(REGISTRY)).toBe(false);
  });

  test("without --write, discover still writes nothing and registers nothing", async () => {
    const { deps, disk } = setup();
    expect(await cli(["discover"], deps)).toBe(0);
    expect(disk.contents.has(MAP)).toBe(false);
    expect(disk.contents.has(REGISTRY)).toBe(false);
  });
});
