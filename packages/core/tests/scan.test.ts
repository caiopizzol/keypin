import { assert, describe, expect, test } from "vite-plus/test";
import { envFileKind, envNames, envValues, workflowRefs, wranglerWorkers } from "../src/index";

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
    expect(names).toEqual(["API_KEY", "TOKEN", "SPACED", "PEM", "EMPTY", "lower_case", "1BAD"]);
    expect(JSON.stringify(names)).not.toContain(SENTINEL);
  });

  test("an escaped quote doesn't end a single-quoted or backtick value", () => {
    expect(envNames(`A='it\\'s\nLEAK_${SENTINEL}=x\nend'\nB=1`)).toEqual(["A", "B"]);
    expect(envNames("A=`x\\`\nLEAK2=y\n`\nB=1")).toEqual(["A", "B"]);
  });

  test("lines of a multi-line value that end in base64 padding aren't names", () => {
    const text = [
      `CERT="MIIBIjANBgkqhkiG9w0BAQEFAAOC`,
      `QWxhZGRpbjpvcGVuIHNlc2FtZQ==`,
      `U0VOVElORUxWQUxVRQ=`,
      `"`,
      "NEXT=1",
    ].join("\n");
    expect(envNames(text)).toEqual(["CERT", "NEXT"]);
  });

  test("keys dotenv accepts, dotted, dashed or with a colon, open multi-line values too", () => {
    const text = [
      `app.key="first line`,
      `HIDDEN${SENTINEL}=value`,
      `"`,
      "my-key: plain",
      "AFTER=1",
    ].join("\n");
    const names = envNames(text);
    expect(names).toEqual(["app.key", "my-key", "AFTER"]);
    expect(JSON.stringify(names)).not.toContain(SENTINEL);
  });
});

describe("env values", () => {
  test("reads each value as dotenv does, inside a Secret", () => {
    const text = [
      "PLAIN= plain value  # a comment",
      `export SINGLE='it is "quoted"'`,
      `DOUBLE="line one\\nline two"`,
      'MULTI="first',
      'second"',
      "EMPTY=",
      "COLON: value",
      "",
    ].join("\r\n");
    const values = envValues(text);
    expect(Object.fromEntries([...values].map(([name, value]) => [name, value.reveal()]))).toEqual({
      PLAIN: "plain value",
      SINGLE: 'it is "quoted"',
      DOUBLE: "line one\nline two",
      MULTI: "first\nsecond",
      EMPTY: "",
      COLON: "value",
    });
    expect(JSON.stringify([...values])).not.toContain("plain value");
  });

  test("the last line for a name wins, and names keep their first place", () => {
    const values = envValues(`A=${SENTINEL}\nB=2\nA=3\n`);
    expect([...values.keys()]).toEqual(["A", "B"]);
    expect(values.get("A")?.reveal()).toBe("3");
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

  test("keeps which secrets each job uses with the environment it declares", () => {
    const refs = workflowRefs(`
on: push
env:
  TOP: \${{ secrets.TOP_LEVEL }}
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ secrets.TEST_TOKEN }}
  deploy:
    environment:
      name: production
      url: https://example.com
    steps:
      - run: echo \${{ secrets.API_TOKEN }}
  preview:
    environment: \${{ github.ref_name }}
    steps:
      - run: echo \${{ secrets.PREVIEW_TOKEN }}
`);
    assert(refs);
    expect(refs.uses).toEqual([
      { environment: null, secrets: ["TOP_LEVEL"] },
      { environment: null, secrets: ["TEST_TOKEN"] },
      { environment: "production", secrets: ["API_TOKEN"] },
      { environment: "${{ github.ref_name }}", secrets: ["PREVIEW_TOKEN"] },
    ]);
    expect(refs.secrets.toSorted()).toEqual([
      "API_TOKEN",
      "PREVIEW_TOKEN",
      "TEST_TOKEN",
      "TOP_LEVEL",
    ]);
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

  test("an alias that refers to itself is read once instead of recursing forever", () => {
    const refs = workflowRefs(
      "loop: &x\n  again: *x\njobs:\n  a:\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n",
    );
    expect(refs).toMatchObject({ secrets: ["TOKEN"], hidesUses: false });
  });

  test("strings inside an expression neither end it nor count as references", () => {
    const refs = workflowRefs(`
jobs:
  a:
    if: "'secrets.IN_IF' != secrets.REAL_IF"
    steps:
      - run: "\${{ format('{{\\"t\\":\\"{0}\\"}}', secrets.API_TOKEN) }}"
      - run: "\${{ 'secrets.MISSING' }} \${{ 'it''s' }} \${{ secrets['QUOTED'] }}"
`);
    assert(refs);
    expect(refs.secrets.toSorted()).toEqual(["API_TOKEN", "QUOTED", "REAL_IF"]);
  });

  test("reads a workflow saved with a byte order mark", () => {
    const refs = workflowRefs(
      "\uFEFFjobs:\n  a:\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n",
    );
    assert(refs);
    expect(refs.secrets).toEqual(["TOKEN"]);
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

  test("skips an env with no routes and no workers.dev URL that nothing triggers", () => {
    const parsed = wranglerWorkers(
      `{
  "name": "api",
  "routes": [{ "pattern": "api.example.com/*", "zone_name": "example.com" }],
  "workers_dev": false,
  "preview_urls": false,
  "env": {
    "dev": { "routes": [] },
    "own": { "routes": [], "workers_dev": false },
    "inherited": {},
    "url": { "routes": [], "workers_dev": true },
    "cron": { "routes": [], "triggers": { "crons": ["0 * * * *"] } },
    "queue": { "routes": [], "queues": { "consumers": [{ "queue": "jobs" }] } },
    "preview": { "routes": [], "preview_urls": true },
    "workflow": { "routes": [], "workflows": [{ "name": "jobs", "binding": "JOBS", "class_name": "Jobs" }] },
    "bound": { "routes": [], "workflows": [{ "name": "jobs", "binding": "JOBS", "class_name": "Jobs", "script_name": "other" }] },
  },
}`,
      "wrangler.json",
    );
    assert(parsed.ok);
    expect(parsed.workers.map((w) => w.env)).toEqual([
      null,
      "inherited",
      "url",
      "cron",
      "queue",
      "preview",
      "workflow",
    ]);
    const previewUnset = wranglerWorkers(
      `{ "name": "api", "workers_dev": false, "env": { "dev": { "routes": [] } } }`,
      "wrangler.json",
    );
    assert(previewUnset.ok);
    expect(previewUnset.workers.map((w) => w.env)).toEqual([null]);
    const previewInherited = wranglerWorkers(
      `{ "name": "api", "workers_dev": false, "preview_urls": true, "env": { "dev": { "routes": [] } } }`,
      "wrangler.json",
    );
    assert(previewInherited.ok);
    expect(previewInherited.workers.map((w) => w.env)).toEqual([null, "dev"]);
    const unset = wranglerWorkers(
      `name = "api"
[env.dev]
routes = []
`,
      "wrangler.toml",
    );
    assert(unset.ok);
    expect(unset.workers.map((w) => w.env)).toEqual([null, "dev"]);
  });

  test("reads a config saved with a byte order mark, as Wrangler does", () => {
    for (const config of ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]) {
      const text = config.endsWith(".toml") ? 'name = "api"\n' : '{ "name": "api" }';
      const parsed = wranglerWorkers(`\uFEFF${text}`, config);
      assert(parsed.ok, config);
      expect(parsed.workers.map((w) => w.worker)).toEqual(["api"]);
    }
  });
});
