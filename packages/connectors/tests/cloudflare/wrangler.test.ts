import { assert, describe, expect, test } from "vite-plus/test";
import { calledAcross, wranglerWorkers } from "../../src/cloudflare/index";
import { configsWranglerUses } from "../../src/cloudflare/wrangler";

const SENTINEL = "sentinel-value-7f3a9c2e1d";
const ACCOUNT = "11111111111111111111111111111111";

describe("wrangler configs", () => {
  test("an env another config's binding calls is reported, not skipped", () => {
    const api = `name = "api"\n\n[env.internal]\nroutes = []\nworkers_dev = false\n`;
    const web = `name = "web"\n\n[[services]]\nbinding = "API"\nservice = "api-internal"\n`;
    const configs = [
      { text: api, config: "apps/api/wrangler.toml" },
      { text: web, config: "apps/web/wrangler.toml" },
    ];
    const alone = wranglerWorkers(api, "apps/api/wrangler.toml");
    assert(alone.ok);
    expect(alone.skipped).toEqual(["internal"]);
    const parsed = wranglerWorkers(api, "apps/api/wrangler.toml", calledAcross(configs));
    assert(parsed.ok);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.workers.map((w) => w.worker)).toEqual(["api", "api-internal"]);
  });

  test("a binding counts only for the Worker of that name in the caller's account", () => {
    const OTHER = "22222222222222222222222222222222";
    const api = `name = "api"\naccount_id = "${ACCOUNT}"\n\n[env.internal]\nroutes = []\nworkers_dev = false\n`;
    const web = (account: string) =>
      `name = "web"\naccount_id = "${account}"\n\n[[services]]\nbinding = "API"\nservice = "api-internal"\n`;
    const skipped = (account: string) => {
      const configs = [{ text: web(account), config: "apps/web/wrangler.toml" }];
      const parsed = wranglerWorkers(api, "apps/api/wrangler.toml", calledAcross(configs));
      assert(parsed.ok);
      return parsed.skipped;
    };
    expect(skipped(OTHER)).toEqual(["internal"]);
    expect(skipped(ACCOUNT)).toEqual([]);
  });

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
    "objects": { "routes": [], "durable_objects": { "bindings": [{ "name": "ROOMS", "class_name": "Room" }] } },
    "elsewhere": { "routes": [], "durable_objects": { "bindings": [{ "name": "ROOMS", "class_name": "Room", "script_name": "other" }] } },
    "service": { "routes": [] },
    "tail": { "routes": [] },
    "caller": { "routes": [], "services": [{ "binding": "API", "service": "api-service" }], "tail_consumers": [{ "service": "api-tail" }] },
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
      "objects",
      "service",
      "tail",
    ]);
    expect(parsed.skipped).toEqual(["dev", "own", "bound", "elsewhere", "caller"]);
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

  test("keeps an env whose Worker exports Durable Objects or receives email", () => {
    const env = `"env": { "dev": { "routes": [] } }`;
    for (const top of [
      `"exports": { "Room": { "type": "durable-object", "storage": "sqlite" } }`,
      `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }]`,
      `"addresses": ["support@example.com"]`,
    ]) {
      const parsed = wranglerWorkers(
        `{ "name": "api", "workers_dev": false, ${top}, ${env} }`,
        "wrangler.json",
      );
      assert(parsed.ok);
      expect(parsed.workers.map((w) => w.env)).toEqual([null, "dev"]);
    }
  });

  test("reads a config saved with a byte order mark, as Wrangler does", () => {
    for (const config of ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]) {
      const text = config.endsWith(".toml") ? 'name = "api"\n' : '{ "name": "api" }';
      const parsed = wranglerWorkers(`\uFEFF${text}`, config);
      assert(parsed.ok, config);
      expect(parsed.workers.map((w) => w.worker)).toEqual(["api"]);
    }
  });

  test("reads only the config wrangler uses in a folder: json, then jsonc, then toml", () => {
    expect(
      configsWranglerUses([
        "wrangler.toml",
        "wrangler.jsonc",
        "apps/api/wrangler.toml",
        "apps/web/wrangler.jsonc",
        "apps/web/wrangler.json",
      ]),
    ).toEqual({
      used: ["wrangler.jsonc", "apps/api/wrangler.toml", "apps/web/wrangler.json"],
      ignored: [
        { config: "wrangler.toml", used: "wrangler.jsonc" },
        { config: "apps/web/wrangler.jsonc", used: "apps/web/wrangler.json" },
      ],
    });
  });

  test("reads Windows paths the same way", () => {
    expect(
      configsWranglerUses(["wrangler.toml", "wrangler.jsonc", "apps\\api\\wrangler.toml"]),
    ).toEqual({
      used: ["wrangler.jsonc", "apps\\api\\wrangler.toml"],
      ignored: [{ config: "wrangler.toml", used: "wrangler.jsonc" }],
    });
  });

  test("a Pages config declares no Worker", () => {
    for (const [text, config] of [
      [
        `name = "site"\npages_build_output_dir = "dist"\n[secrets]\nrequired = ["KEY"]\n`,
        "wrangler.toml",
      ],
      [`{ "name": "site", "pages_build_output_dir": "./dist" }`, "wrangler.jsonc"],
    ] as const) {
      expect(wranglerWorkers(text, config)).toEqual({
        ok: true,
        workers: [],
        skipped: [],
        pages: true,
      });
    }
  });
});
