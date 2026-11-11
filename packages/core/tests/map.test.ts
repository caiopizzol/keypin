import { assert, describe, expect, test } from "vite-plus/test";
import { parseMap } from "../src/index";
import { MAP_FILE, VALID_MAP } from "./fixtures";

const VAULTS = `
[vaults.personal]
account = "my.1password.com"
vault = "Private"
`;

function errorsOf(text: string): string[] {
  const result = parseMap(text, MAP_FILE);
  if (result.ok) throw new Error("expected the map to be rejected");
  return result.errors;
}

describe("a valid map", () => {
  test("the design's example parses into typed entries", () => {
    const result = parseMap(VALID_MAP, MAP_FILE);
    expect(result).toEqual({
      ok: true,
      map: {
        file: MAP_FILE,
        environments: ["dev", "prod"],
        keys: [
          {
            id: "web-session",
            env: "SESSION_SECRET",
            rotateEvery: "180d",
            environments: {
              dev: {
                ref: {
                  kind: "1password",
                  account: "my.1password.com",
                  vault: "Private",
                  item: "web dev session secret",
                },
                publish: [],
              },
              prod: {
                ref: {
                  kind: "1password",
                  account: "my.1password.com",
                  vault: "Private",
                  item: "web prod session secret",
                },
                publish: [
                  {
                    to: "cloudflare-worker",
                    account: "11111111111111111111111111111111",
                    worker: "web",
                  },
                  { to: "github-actions", repo: "acme/web", account: "acme" },
                ],
              },
            },
          },
        ],
      },
    });
  });

  test("tables instead of inline tables, an explicit GitHub account, and no rotate_every", () => {
    const result = parseMap(
      `${VAULTS}
[keys.billing-stripe]
env = "STRIPE_API_KEY"

[keys.billing-stripe.prod]
vault = "personal"
item = "billing stripe api key"

[[keys.billing-stripe.prod.publish]]
to = "github-actions"
repo = "acme/billing"
account = "acme-ops"
`,
      MAP_FILE,
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const [key] = result.map.keys;
    expect(key?.rotateEvery).toBeNull();
    expect(key?.environments.dev).toBeUndefined();
    expect(key?.environments.prod?.publish).toEqual([
      { to: "github-actions", repo: "acme/billing", account: "acme-ops" },
    ]);
  });

  test("an empty map has no keys", () => {
    expect(parseMap("", MAP_FILE)).toEqual({
      ok: true,
      map: { file: MAP_FILE, environments: ["dev", "prod"], keys: [] },
    });
  });

  test("declared environments replace dev and prod", () => {
    const result = parseMap(
      `environments = ["local", "staging", "production"]\n${VAULTS}[keys.k]\nenv = "A"\nlocal = { vault = "personal", item = "l" }\nstaging = { vault = "personal", item = "s" }\n`,
      MAP_FILE,
    );
    assert(result.ok, JSON.stringify(result));
    expect(result.map.environments).toEqual(["local", "staging", "production"]);
    expect(Object.keys(result.map.keys[0]?.environments ?? {})).toEqual(["local", "staging"]);
    expect(
      errorsOf(
        `environments = ["local", "production"]\n${VAULTS}[keys.k]\nenv = "A"\ndev = { vault = "personal", item = "i" }\n`,
      ),
    ).toEqual([
      `${MAP_FILE}: key "k": unknown field "dev"; environments are "local", "production"`,
      `${MAP_FILE}: key "k": needs at least one of "local", "production"`,
    ]);
  });

  test("an environment named like an object property is read only from the key", () => {
    const result = parseMap(
      `environments = ["constructor", "prod"]\n${VAULTS}[keys.k]\nenv = "A"\nprod = { vault = "personal", item = "p" }\n`,
      MAP_FILE,
    );
    assert(result.ok, JSON.stringify(result));
    expect(Object.keys(result.map.keys[0]?.environments ?? {})).toEqual(["prod"]);
    expect(result.map.keys[0]?.environments.constructor).toBeUndefined();
  });

  test.each([
    [
      `environments = []`,
      `"environments" must be a list of names, such as ["dev", "staging", "prod"]`,
    ],
    [
      `environments = "prod"`,
      `"environments" must be a list of names, such as ["dev", "staging", "prod"]`,
    ],
    [
      `environments = ["Prod"]`,
      `environment "Prod": a name uses lowercase letters, digits and dashes`,
    ],
    [`environments = ["env"]`, `environment "env": that name is a key field`],
    [`environments = ["dev", "dev"]`, `environment "dev" is listed twice`],
  ])("%s is rejected", (line, message) => {
    expect(errorsOf(`${line}\n`)).toEqual([`${MAP_FILE}: ${message}`]);
  });
});

describe("missing fields", () => {
  const base = { env: '"SESSION_SECRET"' };
  const key = (fields: Record<string, string>) =>
    `${VAULTS}\n[keys.k]\n${Object.entries(fields)
      .map(([name, value]) => `${name} = ${value}`)
      .join("\n")}\n`;

  test.each([
    ["env", key({ prod: '{ vault = "personal", item = "i" }' }), `key "k": missing field "env"`],
    ["an environment", key(base), `key "k": needs at least one of "dev", "prod"`],
    ["vault", key({ ...base, prod: '{ item = "i" }' }), `key "k" prod: missing field "vault"`],
    [
      "item",
      key({ ...base, prod: '{ vault = "personal" }' }),
      `key "k" prod: missing field "item"`,
    ],
    [
      "worker",
      key({
        ...base,
        prod: '{ vault = "personal", item = "i", publish = [{ to = "cloudflare-worker", account = "11111111111111111111111111111111" }] }',
      }),
      `key "k" prod: publish[0]: missing field "worker"`,
    ],
    [
      "a Worker's account",
      key({
        ...base,
        prod: '{ vault = "personal", item = "i", publish = [{ to = "cloudflare-worker", worker = "w" }] }',
      }),
      `key "k" prod: publish[0]: missing field "account"`,
    ],
    [
      "repo",
      key({
        ...base,
        prod: '{ vault = "personal", item = "i", publish = [{ to = "github-actions" }] }',
      }),
      `key "k" prod: publish[0]: missing field "repo"`,
    ],
    [
      "to",
      key({ ...base, prod: '{ vault = "personal", item = "i", publish = [{ repo = "a/b" }] }' }),
      `key "k" prod: publish[0]: missing field "to"`,
    ],
  ])("%s", (_, text, message) => {
    expect(errorsOf(text)).toContain(`${MAP_FILE}: ${message}`);
  });

  test("a vault's account", () => {
    expect(errorsOf(`[vaults.op]\nkind = "1password"\nvault = "Private"\n`)).toEqual([
      `${MAP_FILE}: vault "op": missing field "account"`,
    ]);
  });

  test("an undeclared vault", () => {
    expect(errorsOf(`[keys.k]\nenv = "A"\ndev = { vault = "op", item = "i" }\n`)).toEqual([
      `${MAP_FILE}: key "k" dev: field "vault" names a vault that isn't under [vaults]`,
    ]);
  });
});

describe("unknown fields are errors that name the file, the key and the field", () => {
  test.each([
    ["top level", `owner = "x"\n`, `unknown top-level field "owner"`],
    [
      "vault",
      `[vaults.op]\nkind = "1password"\naccount = "a"\nvault = "v"\ntoken = "x"\n`,
      `vault "op": unknown field "token"`,
    ],
    [
      "key",
      `${VAULTS}[keys.k]\nenv = "A"\nrotate = "90d"\ndev = { vault = "personal", item = "i" }\n`,
      `key "k": unknown field "rotate"; environments are "dev", "prod"`,
    ],
    [
      "environment name",
      `${VAULTS}[keys.k]\nenv = "A"\ndev = { vault = "personal", item = "i" }\nstaging = { vault = "personal", item = "i" }\n`,
      `key "k": unknown field "staging"; environments are "dev", "prod"`,
    ],
    [
      "environment",
      `${VAULTS}[keys.k]\nenv = "A"\ndev = { vault = "personal", item = "i", value = "x" }\n`,
      `key "k" dev: unknown field "value"`,
    ],
    [
      "Worker target",
      `${VAULTS}[keys.k]\nenv = "A"\nprod = { vault = "personal", item = "i", publish = [{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "w", repo = "x/y" }] }\n`,
      `key "k" prod: publish[0]: unknown field "repo" for cloudflare-worker`,
    ],
    [
      "GitHub target",
      `${VAULTS}[keys.k]\nenv = "A"\nprod = { vault = "personal", item = "i", publish = [{ to = "github-actions", repo = "x/y", environment = "production" }] }\n`,
      `key "k" prod: publish[0]: unknown field "environment" for github-actions`,
    ],
  ])("%s", (_, text, message) => {
    expect(errorsOf(text)).toEqual([`${MAP_FILE}: ${message}`]);
  });

  test("a removed field says to delete it", () => {
    expect(
      errorsOf(
        `${VAULTS}[keys.k]\nenv = "A"\nowner = "o"\nconsumers = []\ndev = { vault = "personal", item = "i" }\n`,
      ),
    ).toEqual([
      `${MAP_FILE}: key "k": field "owner" is no longer used; delete it`,
      `${MAP_FILE}: key "k": field "consumers" is no longer used; delete it`,
    ]);
  });
});

describe("wrong kinds and values", () => {
  test.each([
    [
      "destination",
      `{ to = "dotenv", path = ".env" }`,
      `key "k" prod: publish[0]: field "to" must be one of: cloudflare-worker, github-actions`,
    ],
    [
      "repo without an owner",
      `{ to = "github-actions", repo = "billing" }`,
      `key "k" prod: publish[0]: field "repo" must be "owner/name"`,
    ],
    [
      "duplicate destination",
      `{ to = "github-actions", repo = "a/b" }, { to = "github-actions", repo = "a/b", account = "c" }`,
      `key "k" prod: publish[1]: the same destination as publish[0]`,
    ],
    [
      "non-string field",
      `{ to = "cloudflare-worker", account = 7, worker = "w" }`,
      `key "k" prod: publish[0]: field "account" must be a non-empty string`,
    ],
  ])("%s", (_, targets, message) => {
    const text = `${VAULTS}[keys.k]\nenv = "A"\nprod = { vault = "personal", item = "i", publish = [${targets}] }\n`;
    expect(errorsOf(text)).toEqual([`${MAP_FILE}: ${message}`]);
  });

  test("a vault without a kind is 1Password", () => {
    const result = parseMap(
      `[vaults.p]\naccount = "a"\nvault = "v"\n[keys.k]\nenv = "A"\ndev = { vault = "p", item = "i" }\n`,
      MAP_FILE,
    );
    expect(result.ok && result.map.keys[0]?.environments.dev?.ref.kind).toBe("1password");
  });

  test("an unknown vault kind", () => {
    expect(errorsOf(`[vaults.ss]\nkind = "infisical"\naccount = "a"\nvault = "v"\n`)).toEqual([
      `${MAP_FILE}: vault "ss": field "kind" must be one of: 1password`,
    ]);
  });

  test("a bad rotate_every, env name and key ID", () => {
    expect(
      errorsOf(
        `${VAULTS}[keys.K_1]\nenv = "MY-KEY"\nrotate_every = "soon"\ndev = { vault = "personal", item = "i" }\n`,
      ),
    ).toEqual([
      `${MAP_FILE}: key "K_1": a key ID uses lowercase letters, digits and dashes`,
      `${MAP_FILE}: key "K_1": field "env" must be a variable name: letters, digits and _, not starting with a digit`,
      `${MAP_FILE}: key "K_1": field "rotate_every" must be <n>d, <n>w, <n>m or never`,
    ]);
  });

  test("a GITHUB_ name can't go to github-actions, in any case", () => {
    for (const env of ["GITHUB_TOKEN", "github_app_key"]) {
      expect(
        errorsOf(
          `${VAULTS}[keys.k]\nenv = "${env}"\ndev = { vault = "personal", item = "i" }\nprod = { vault = "personal", item = "i", publish = [{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "w" }, { to = "github-actions", repo = "a/b" }] }\n`,
        ),
      ).toEqual([
        `${MAP_FILE}: key "k" prod: publish[1]: github-actions can't take this key, because GitHub reserves secret names that start with GITHUB_; rename field "env"`,
      ]);
    }
  });

  test("a GITHUB_ name is fine anywhere else", () => {
    const result = parseMap(
      `${VAULTS}[keys.k]\nenv = "GITHUB_TOKEN"\ndev = { vault = "personal", item = "i" }\nprod = { vault = "personal", item = "i", publish = [{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "w" }] }\n`,
      MAP_FILE,
    );
    expect(result.ok).toBe(true);
  });

  test("a duplicate names the first valid entry it repeats, by its place in the map", () => {
    const worker = (name: string) =>
      `{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "${name}" }`;
    const prod = (targets: string[]) =>
      `${VAULTS}[keys.k]\nenv = "A"\nprod = { vault = "personal", item = "i", publish = [${targets.join(", ")}] }\n`;
    expect(errorsOf(prod([worker("x"), worker("x"), worker("y"), worker("y")]))).toEqual([
      `${MAP_FILE}: key "k" prod: publish[1]: the same destination as publish[0]`,
      `${MAP_FILE}: key "k" prod: publish[3]: the same destination as publish[2]`,
    ]);
    expect(errorsOf(prod(["{}", worker("x"), worker("x")]))).toEqual([
      `${MAP_FILE}: key "k" prod: publish[0]: missing field "to"`,
      `${MAP_FILE}: key "k" prod: publish[2]: the same destination as publish[1]`,
    ]);
  });

  test("one destination secret can't belong to two keys, or to a key's dev and prod", () => {
    const repo = `{ to = "github-actions", repo = "acme/billing" }`;
    const twoKeys = `${VAULTS}[keys.token-a]\nenv = "API_TOKEN"\nprod = { vault = "personal", item = "a", publish = [${repo}] }\n[keys.token-b]\nenv = "api_token"\nprod = { vault = "personal", item = "b", publish = [${repo}] }\n`;
    expect(errorsOf(twoKeys)).toEqual([
      `${MAP_FILE}: key "token-b" prod publish[0]: writes the same destination secret as key "token-a" prod publish[0]`,
    ]);
    const devAndProd = `${VAULTS}[keys.deploy]\nenv = "DEPLOY_TOKEN"\ndev = { vault = "personal", item = "b", publish = [${repo}] }\nprod = { vault = "personal", item = "a", publish = [${repo}] }\n`;
    expect(errorsOf(devAndProd)).toEqual([
      `${MAP_FILE}: key "deploy" prod publish[0]: writes the same destination secret as key "deploy" dev publish[0]`,
    ]);
  });

  test("a Worker's account is a Cloudflare account ID", () => {
    expect(
      errorsOf(
        `${VAULTS}[keys.k]\nenv = "A"\nprod = { vault = "personal", item = "i", publish = [{ to = "cloudflare-worker", account = "me@example.com", worker = "w" }] }\n`,
      ),
    ).toEqual([
      `${MAP_FILE}: key "k" prod: publish[0]: field "account" must be a Cloudflare account ID (32 hex characters)`,
    ]);
  });

  test("a GitHub repo compares without case, like GitHub", () => {
    const target = (repo: string) => `{ to = "github-actions", repo = "${repo}" }`;
    expect(
      errorsOf(
        `${VAULTS}[keys.a]\nenv = "TOKEN"\nprod = { vault = "personal", item = "a", publish = [${target("acme/billing")}] }\n[keys.b]\nenv = "TOKEN"\nprod = { vault = "personal", item = "b", publish = [${target("Acme/Billing")}] }\n`,
      ),
    ).toEqual([
      `${MAP_FILE}: key "b" prod publish[0]: writes the same destination secret as key "a" prod publish[0]`,
    ]);
  });

  test("the same Worker and secret name in two Cloudflare accounts are two secrets", () => {
    const worker = (account: string) =>
      `{ to = "cloudflare-worker", account = "${account.repeat(8)}", worker = "api" }`;
    const result = parseMap(
      `${VAULTS}[keys.k]\nenv = "TOKEN"\ndev = { vault = "personal", item = "d", publish = [${worker("aaaa")}] }\nprod = { vault = "personal", item = "p", publish = [${worker("bbbb")}] }\n`,
      MAP_FILE,
    );
    expect(result.ok).toBe(true);
  });

  test("the same Worker secret name in two Workers, or another case of a Worker secret, is fine", () => {
    const worker = (name: string) =>
      `{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "${name}" }`;
    const result = parseMap(
      `${VAULTS}[keys.a]\nenv = "TOKEN"\nprod = { vault = "personal", item = "a", publish = [${worker("one")}] }\n[keys.b]\nenv = "TOKEN"\nprod = { vault = "personal", item = "b", publish = [${worker("two")}] }\n[keys.c]\nenv = "token"\nprod = { vault = "personal", item = "c", publish = [${worker("one")}] }\n`,
      MAP_FILE,
    );
    expect(result.ok).toBe(true);
  });

  test("publish must be a list", () => {
    expect(
      errorsOf(
        `${VAULTS}[keys.k]\nenv = "A"\nprod = { vault = "personal", item = "i", publish = { to = "github-actions", repo = "a/b" } }\n`,
      ),
    ).toEqual([`${MAP_FILE}: key "k" prod: field "publish" must be a list`]);
  });

  test("invalid TOML names the file", () => {
    const [error] = errorsOf(`env = "A"\nenv = "B"\n`);
    expect(error).toMatch(new RegExp(`^${MAP_FILE}: not valid TOML: `));
  });

  test("no error quotes the text it found, so a value pasted by mistake stays out of the output", () => {
    const pasted = "sentinel-pasted-value-5555";
    const target = (fields: string) =>
      `${VAULTS}[keys.k]\nenv = "A"\nprod = { vault = "personal", item = "i", publish = [${fields}] }\n`;
    const texts = [
      `API_KEY=${pasted}\n`,
      `k = ${pasted}\n`,
      `k = { a = ${pasted} }\n`,
      `k = [${pasted}]\n`,
      `k = 1${pasted}\n`,
      `k = "\\q${pasted}"\n`,
      `k = 'it''s ${pasted}'\n`,
      `k = \u00e9${pasted}\n`,
      `k = "\u0001${pasted}"\n`,
      `k = \u0002${pasted}\n`,
      `${VAULTS}[keys.k]\nenv = "${pasted}"\ndev = { vault = "personal", item = "i" }\n`,
      `${VAULTS}[keys.k]\nenv = "A"\nrotate_every = "${pasted}"\ndev = { vault = "personal", item = "i" }\n`,
      `${VAULTS}[keys.k]\nenv = "A"\ndev = { vault = "${pasted}", item = "i" }\n`,
      `[vaults.v]\nkind = "${pasted}"\naccount = "a"\nvault = "v"\n`,
      target(`{ to = "${pasted}" }`),
      target(`{ to = "github-actions", repo = "${pasted}" }`),
      target(
        `{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "${pasted}" }, { to = "cloudflare-worker", account = "22222222222222222222222222222222", worker = "${pasted}" }`,
      ),
    ];
    for (const text of texts) {
      const errors = errorsOf(text);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join("\n")).not.toContain(pasted);
      expect(errors.join("\n")).not.toContain("sentinel");
      expect(errors.join("\n")).not.toMatch(/0x[0-9a-f]{2}/i);
    }
  });

  test("a TOML error keeps what went wrong and drops the quoted text", () => {
    expect(errorsOf(`API_KEY=sentinel-x\n`)).toEqual([
      `${MAP_FILE}: not valid TOML: Strings must be quoted`,
    ]);
    expect(errorsOf(`[a]\nb = 1\n[a]\n`)).toEqual([
      `${MAP_FILE}: not valid TOML: Cannot redefine table`,
    ]);
    expect(errorsOf(`k = \u00e9x\n`)).toEqual([`${MAP_FILE}: not valid TOML: Expected a value`]);
    expect(errorsOf(`k = "\u0001x"\n`)).toEqual([
      `${MAP_FILE}: not valid TOML: Control character must be escaped in a string`,
    ]);
    expect(errorsOf(`k = "a" b\n`)).toEqual([
      `${MAP_FILE}: not valid TOML: Expected a newline or end of file after a key/value pair`,
    ]);
  });

  test("every error is reported, not just the first", () => {
    expect(errorsOf(`${VAULTS}[keys.a]\nenv = "A"\nrotate = "1d"\n\n[keys.b]\n`)).toHaveLength(4);
  });
});

describe("an issue section", () => {
  const ACCOUNT = "e48c9afabc4ff0cda321d0cf69b8943f";
  const mapWith = (issue: string) => `${VAULTS}
[keys.site-deploy]
env = "CLOUDFLARE_API_TOKEN"

[keys.site-deploy.prod]
vault = "personal"
item = "site deploy token"

[keys.site-deploy.prod.issue]
${issue}
`;

  test("names the provider, the account and an admin item in the same vault", () => {
    const result = parseMap(
      mapWith(
        `provider = "cloudflare-account-token"\naccount = "${ACCOUNT}"\nadmin = "shared cloudflare token admin"`,
      ),
      MAP_FILE,
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.map.keys[0]?.environments.prod?.issue).toEqual({
      provider: "cloudflare-account-token",
      account: ACCOUNT,
      admin: {
        kind: "1password",
        account: "my.1password.com",
        vault: "Private",
        item: "shared cloudflare token admin",
      },
    });
  });

  test("an entry without one has no issue", () => {
    const result = parseMap(VALID_MAP, MAP_FILE);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.map.keys[0]?.environments.prod).not.toHaveProperty("issue");
  });

  test.each([
    [`account = "${ACCOUNT}"\nadmin = "a"`, `missing field "provider"`],
    [
      `provider = "aws-iam-key"\naccount = "${ACCOUNT}"\nadmin = "a"`,
      `field "provider" must be one of: cloudflare-account-token`,
    ],
    [
      `provider = "cloudflare-account-token"\naccount = "personal"\nadmin = "a"`,
      `field "account" must be a Cloudflare account ID (32 hex characters)`,
    ],
    [
      `provider = "cloudflare-account-token"\naccount = "${ACCOUNT}"\nadmin = "site deploy token"`,
      `field "admin" names the key's own item; the admin token needs its own item`,
    ],
    [
      `provider = "cloudflare-account-token"\naccount = "${ACCOUNT}"\nadmin = "a"\npermissions = []`,
      `unknown field "permissions"`,
    ],
  ])("%s is refused", (issue, message) => {
    expect(errorsOf(mapWith(issue))).toEqual([
      `${MAP_FILE}: key "site-deploy" prod: issue: ${message}`,
    ]);
  });
});
