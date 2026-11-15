import { assert, describe, expect, test } from "vite-plus/test";
import { wranglerWorkers } from "../src/index";

const SENTINEL = "sentinel-value-7f3a9c2e1d";
const ACCOUNT = "11111111111111111111111111111111";

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
    "self": { "routes": [], "workflows": [{ "name": "jobs", "binding": "JOBS", "class_name": "Jobs", "script_name": "api-self" }] },
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
      "self",
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
