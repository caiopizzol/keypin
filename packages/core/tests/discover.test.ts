import { assert, describe, expect, test } from "vite-plus/test";
import {
  buildDiscovery,
  type DiscoverInput,
  draftMap,
  envFileKind,
  envNames,
  parseMap,
  workflowRefs,
  wranglerWorkers,
} from "../src/index";

const SENTINEL = "sentinel-value-7f3a9c2e1d";
const ACCOUNT = "11111111111111111111111111111111";

describe("env files", () => {
  test("names the files that set keys and the ones that only list them", () => {
    expect(envFileKind(".env")).toBe("set");
    expect(envFileKind(".env.local")).toBe("set");
    expect(envFileKind(".dev.vars")).toBe("set");
    expect(envFileKind(".dev.vars.staging")).toBe("set");
    expect(envFileKind(".env.example")).toBe("expected");
    expect(envFileKind(".dev.vars.sample")).toBe("expected");
    expect(envFileKind(".env.template")).toBe("expected");
    expect(envFileKind(".envrc")).toBeNull();
    expect(envFileKind("env")).toBeNull();
    expect(envFileKind("wrangler.toml")).toBeNull();
  });

  test("reads names only, including export lines, and skips multi-line values", () => {
    const text = [
      "# A_COMMENT=nope",
      `API_KEY=${SENTINEL}`,
      `export TOKEN="${SENTINEL}"`,
      "  SPACED = x",
      `PEM="-----BEGIN-----`,
      `NOT_A_NAME=${SENTINEL}`,
      `-----END-----"`,
      "EMPTY=",
      "lower_case=1",
      "1BAD=2",
      "no equals sign",
      `API_KEY=${SENTINEL}`,
    ].join("\n");
    const names = envNames(text);
    expect(names).toEqual(["API_KEY", "TOKEN", "SPACED", "PEM", "EMPTY", "lower_case"]);
    expect(JSON.stringify(names)).not.toContain(SENTINEL);
  });
});

describe("workflows", () => {
  test("finds secrets and vars in expressions and if conditions, not in comments", () => {
    const refs = workflowRefs(`
on: push
jobs:
  deploy:
    if: secrets.DEPLOY_ON != ''
    environment: production
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ secrets.API_TOKEN }} \${{ vars.REGION }}"
        env:
          # OLD: \${{ secrets.COMMENTED_OUT }}
          KEY: \${{ secrets['BRACKET_KEY'] }}
          GH: \${{ secrets.GITHUB_TOKEN }}
          lower: \${{ secrets.lower_name }}
`);
    assert(refs);
    expect(refs.secrets.toSorted()).toEqual([
      "API_TOKEN",
      "BRACKET_KEY",
      "DEPLOY_ON",
      "GITHUB_TOKEN",
      "LOWER_NAME",
    ]);
    expect(refs.vars).toEqual(["REGION"]);
    expect(refs.environments).toEqual(["production"]);
    expect(refs.hidesUses).toBe(false);
  });

  test("notices secrets: inherit and toJSON(secrets), which can hide uses", () => {
    expect(
      workflowRefs(`
jobs:
  call:
    uses: ./.github/workflows/deploy.yml
    secrets: inherit
`)?.hidesUses,
    ).toBe(true);
    expect(
      workflowRefs("jobs:\n  a:\n    steps:\n      - run: echo '${{ toJSON(secrets) }}'\n")
        ?.hidesUses,
    ).toBe(true);
  });

  test("returns null for a file that isn't YAML", () => {
    expect(workflowRefs("jobs: [unclosed")).toBeNull();
  });
});

describe("wrangler configs", () => {
  test("reads the Worker, account, required secrets and var names from JSONC", () => {
    const parsed = wranglerWorkers(
      `{
  // a comment
  "name": "billing",
  "account_id": "${ACCOUNT}",
  "vars": { "REGION": "${SENTINEL}" },
  "secrets": { "required": ["STRIPE_KEY"] },
  "env": {
    "staging": { "vars": { "STAGE": "x" }, "secrets": { "required": ["STAGING_KEY"] } },
    "named": { "name": "billing-named", "account_id": "not-an-id" },
  },
}`,
      "wrangler.jsonc",
    );
    assert(parsed.ok);
    expect(parsed.workers).toEqual([
      {
        config: "wrangler.jsonc",
        env: null,
        worker: "billing",
        account: ACCOUNT,
        required: ["STRIPE_KEY"],
        vars: ["REGION"],
      },
      {
        config: "wrangler.jsonc",
        env: "staging",
        worker: "billing-staging",
        account: ACCOUNT,
        required: ["STAGING_KEY"],
        vars: ["STAGE"],
      },
      {
        config: "wrangler.jsonc",
        env: "named",
        worker: "billing-named",
        account: null,
        required: null,
        vars: [],
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
  });

  test("reads TOML, and reports a config it can't parse", () => {
    const parsed = wranglerWorkers(
      `name = "api"\n[vars]\nMODE = "${SENTINEL}"\n[env.operator]\nname = "api-operator"\n`,
      "wrangler.toml",
    );
    assert(parsed.ok);
    expect(parsed.workers.map((w) => [w.worker, w.account, w.vars])).toEqual([
      ["api", null, ["MODE"]],
      ["api-operator", null, []],
    ]);
    expect(wranglerWorkers("name = ", "wrangler.toml")).toEqual({ ok: false });
  });
});

function input(overrides: Partial<DiscoverInput> = {}): DiscoverInput {
  return {
    envFiles: [],
    workflows: [],
    workers: [],
    github: null,
    map: null,
    unknowns: [],
    ...overrides,
  };
}

describe("buildDiscovery", () => {
  test("places each name local, cloud or both, with every source", () => {
    const result = buildDiscovery(
      input({
        envFiles: [
          { path: ".dev.vars", kind: "set", names: ["STRIPE_KEY", "LOCAL_ONLY"], tracked: false },
          {
            path: ".dev.vars.example",
            kind: "expected",
            names: ["STRIPE_KEY", "TODO_KEY"],
            tracked: true,
          },
        ],
        workflows: [
          {
            path: ".github/workflows/deploy.yml",
            refs: { secrets: ["DEPLOY_TOKEN"], vars: [], environments: [], hidesUses: false },
          },
        ],
        workers: [
          {
            config: "wrangler.jsonc",
            env: null,
            worker: "billing",
            account: ACCOUNT,
            required: ["STRIPE_KEY"],
            vars: ["REGION"],
            read: { ok: true, secrets: [{ name: "STRIPE_KEY", updatedAt: null }] },
          },
        ],
        github: {
          repo: "acme/billing",
          read: {
            ok: true,
            secrets: [{ name: "DEPLOY_TOKEN", updatedAt: "2026-11-01T00:00:00Z" }],
          },
        },
      }),
    );
    const where = Object.fromEntries(result.names.map((n) => [n.name, n.where]));
    expect(where).toEqual({
      DEPLOY_TOKEN: "cloud",
      LOCAL_ONLY: "local",
      REGION: "variable",
      STRIPE_KEY: "both",
      TODO_KEY: "declared",
    });
    expect(result.problems).toEqual([]);
    expect(result.unknowns).toEqual([]);
    expect(result.names.every((n) => !n.cloudUnknown)).toBe(true);
  });

  test("reports a tracked env file, a missing or unreferenced secret, and a missing Worker secret", () => {
    const result = buildDiscovery(
      input({
        envFiles: [{ path: "web/.env", kind: "set", names: ["A"], tracked: true }],
        workflows: [
          {
            path: ".github/workflows/ci.yml",
            refs: {
              secrets: ["MISSING", "GITHUB_TOKEN"],
              vars: [],
              environments: ["production"],
              hidesUses: true,
            },
          },
        ],
        workers: [
          {
            config: "wrangler.toml",
            env: null,
            worker: "api",
            account: ACCOUNT,
            required: ["NEEDED"],
            vars: [],
            read: { ok: true, secrets: [] },
          },
        ],
        github: {
          repo: "acme/api",
          read: { ok: true, secrets: [{ name: "EXTRA", updatedAt: null }] },
        },
      }),
    );
    expect(result.problems.map((p) => [p.kind, p.name ?? p.path])).toEqual([
      ["tracked-env-file", "web/.env"],
      ["unreferenced-github-secret", "EXTRA"],
      ["missing-github-secret", "MISSING"],
      ["missing-worker-secret", "NEEDED"],
    ]);
    const messages = result.problems.map((p) => p.message).join("\n");
    expect(messages).toContain(
      "no workflow here references this acme/api secret (a workflow passes secrets on",
    );
    expect(messages).toContain("environment production");
    expect(messages).not.toContain("unused");
    expect(result.names.map((n) => n.name)).not.toContain("GITHUB_TOKEN");
    expect(result.unknowns).toEqual([
      {
        what: "GitHub environment secrets (production)",
        reason: "discover reads repo secrets only",
        cloud: true,
      },
    ]);
  });

  test("says what's unknown and why, and never reports it as none", () => {
    const result = buildDiscovery(
      input({
        envFiles: [{ path: ".env", kind: "set", names: ["A"], tracked: false }],
        workers: [
          {
            config: "wrangler.toml",
            env: null,
            worker: "api",
            account: null,
            required: ["NEEDED"],
            vars: [],
            read: null,
          },
          {
            config: "other/wrangler.toml",
            env: null,
            worker: "other",
            account: ACCOUNT,
            required: ["ALSO_NEEDED"],
            vars: [],
            read: { ok: false, reason: `the wrangler login reaches 2222, not ${ACCOUNT}` },
          },
        ],
        github: { repo: "acme/api", read: { ok: false, reason: "HTTP 403" } },
      }),
    );
    expect(result.problems).toEqual([]);
    expect(result.unknowns.map((u) => [u.what, u.reason])).toEqual([
      ["GitHub Actions secrets of acme/api", "HTTP 403"],
      [
        "Worker secrets of api (wrangler.toml)",
        "wrangler.toml has no account_id, and discover doesn't guess an account",
      ],
      [
        "Worker secrets of other (other/wrangler.toml)",
        `the wrangler login reaches 2222, not ${ACCOUNT}`,
      ],
    ]);
    expect(result.names.find((n) => n.name === "A")).toMatchObject({
      where: "local",
      cloudUnknown: true,
    });
  });

  test("marks names the project's map already has", () => {
    const parsed = parseMap(
      `[vaults.personal]
kind = "1password"
account = "my.1password.com"
vault = "App Secrets"

[keys.billing-stripe]
env = "STRIPE_KEY"
owner = "billing"
dev = { vault = "personal", item = "billing dev stripe key" }
`,
      "keypin.toml",
    );
    assert(parsed.ok);
    const result = buildDiscovery(
      input({
        envFiles: [{ path: ".env", kind: "set", names: ["STRIPE_KEY"], tracked: false }],
        map: parsed.map,
      }),
    );
    expect(result.names).toMatchObject([
      { name: "STRIPE_KEY", where: "local", mapped: ["billing-stripe"] },
    ]);
  });
});

describe("draftMap", () => {
  const discovery = buildDiscovery(
    input({
      envFiles: [
        {
          path: ".dev.vars",
          kind: "set",
          names: ["STRIPE_KEY", "LOCAL_ONLY", "MAPPED"],
          tracked: false,
        },
        { path: ".env.example", kind: "expected", names: ["TODO_KEY"], tracked: true },
      ],
      workers: [
        {
          config: "wrangler.jsonc",
          env: null,
          worker: "billing",
          account: ACCOUNT,
          required: [],
          vars: ["REGION"],
          read: { ok: true, secrets: [{ name: "STRIPE_KEY", updatedAt: null }] },
        },
      ],
      github: {
        repo: "acme/billing",
        read: {
          ok: true,
          secrets: [
            { name: "STRIPE_KEY", updatedAt: null },
            { name: "DEPLOY_TOKEN", updatedAt: null },
          ],
        },
      },
    }),
  );
  discovery.names = discovery.names.map((row) =>
    row.name === "MAPPED" ? { ...row, mapped: ["mapped"] } : row,
  );

  test("drafts dev for local names and prod with every destination found, and it parses", () => {
    const draft = draftMap(discovery.names, {
      owner: "billing",
      githubAccount: "me",
      vault: null,
      takenIds: ["stripe-key"],
    });
    assert(draft !== null);
    expect(draft).toContain("# Fill in the vault");
    const parsed = parseMap(draft, "draft");
    assert(parsed.ok, JSON.stringify(parsed));
    const keys = Object.fromEntries(parsed.map.keys.map((k) => [k.env, k]));
    expect(Object.keys(keys).toSorted()).toEqual(["DEPLOY_TOKEN", "LOCAL_ONLY", "STRIPE_KEY"]);
    expect(keys.STRIPE_KEY?.id).toBe("stripe-key-2");
    expect(keys.STRIPE_KEY?.environments.dev?.ref.item).toBe("billing dev stripe key");
    expect(keys.STRIPE_KEY?.environments.prod?.publish).toEqual([
      { to: "github-actions", repo: "acme/billing", account: "me" },
      { to: "cloudflare-worker", account: ACCOUNT, worker: "billing" },
    ]);
    expect(keys.LOCAL_ONLY?.environments.prod).toBeUndefined();
    expect(keys.DEPLOY_TOKEN?.environments.dev).toBeUndefined();
  });

  test("reuses the map's vault and leaves out the account when it's the repo owner", () => {
    const draft = draftMap(discovery.names, {
      owner: "billing",
      githubAccount: "acme",
      vault: { name: "work", account: "my.1password.com", vault: "App Secrets" },
      takenIds: [],
    });
    assert(draft !== null);
    expect(draft).toContain("copy only the [keys.*] tables");
    const parsed = parseMap(draft, "draft");
    assert(parsed.ok, JSON.stringify(parsed));
    const stripe = parsed.map.keys.find((k) => k.env === "STRIPE_KEY");
    expect(stripe?.environments.prod?.ref).toEqual({
      kind: "1password",
      account: "my.1password.com",
      vault: "App Secrets",
      item: "billing prod stripe key",
    });
    expect(draft).not.toContain('account = "acme"');
  });

  test("has nothing to draft when every set name is mapped", () => {
    const mapped = discovery.names.map((row) => ({ ...row, mapped: ["x"] }));
    expect(
      draftMap(mapped, { owner: "o", githubAccount: null, vault: null, takenIds: [] }),
    ).toBeNull();
  });
});
