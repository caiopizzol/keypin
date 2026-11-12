import { assert, describe, expect, test } from "vite-plus/test";
import { parseMap } from "../src/index";
import { MAP_FILE, VALID_MAP } from "./fixtures";

const VAULTS = `
[1password]
account = "my.1password.com"
`;

function errorsOf(text: string): string[] {
  const result = parseMap(text, MAP_FILE);
  if (result.ok) throw new Error("expected the map to be rejected");
  return result.errors;
}

describe("a valid map", () => {
  test("a map saved with a byte order mark parses the same", () => {
    expect(parseMap(`\uFEFF${VALID_MAP}`, MAP_FILE)).toEqual(parseMap(VALID_MAP, MAP_FILE));
  });

  test("the design's example parses into typed entries", () => {
    const result = parseMap(VALID_MAP, MAP_FILE);
    expect(result).toEqual({
      ok: true,
      map: {
        file: MAP_FILE,
        account: "my.1password.com",
        environments: ["dev", "prod"],
        keys: [
          {
            name: "SESSION_SECRET",
            rotateEvery: "180d",
            environments: {
              dev: {
                ref: {
                  kind: "1password",
                  account: "my.1password.com",
                  vault: "Private",
                  item: "web dev session secret",
                  section: null,
                  field: "password",
                },
                publish: [],
              },
              prod: {
                ref: {
                  kind: "1password",
                  account: "my.1password.com",
                  vault: "Private",
                  item: "web prod session secret",
                  section: null,
                  field: "password",
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

  test("tables instead of inline tables, and no rotate_every", () => {
    const result = parseMap(
      `${VAULTS}
[keys.STRIPE_API_KEY]

[keys.STRIPE_API_KEY.prod]
from = "op://Private/billing stripe api key/password"

[[keys.STRIPE_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`,
      MAP_FILE,
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const [key] = result.map.keys;
    expect(key?.rotateEvery).toBeNull();
    expect(key?.environments.dev).toBeUndefined();
    expect(key?.environments.prod?.publish).toEqual([
      { to: "github-actions", repo: "acme/billing", account: "acme" },
    ]);
  });

  test("an empty map has no keys", () => {
    expect(parseMap("", MAP_FILE)).toEqual({
      ok: true,
      map: { file: MAP_FILE, account: null, environments: ["dev", "prod"], keys: [] },
    });
  });

  test("declared environments replace dev and prod", () => {
    const result = parseMap(
      `environments = ["local", "staging", "production"]\n${VAULTS}[keys.A]\nlocal = "op://Private/l/password"\nstaging = "op://Private/s/password"\n`,
      MAP_FILE,
    );
    assert(result.ok, JSON.stringify(result));
    expect(result.map.environments).toEqual(["local", "staging", "production"]);
    expect(Object.keys(result.map.keys[0]?.environments ?? {})).toEqual(["local", "staging"]);
    expect(
      errorsOf(
        `environments = ["local", "production"]\n${VAULTS}[keys.A]\ndev = "op://Private/i/password"\n`,
      ),
    ).toEqual([
      `${MAP_FILE}: key "A": unknown field "dev"; environments are "local", "production"`,
      `${MAP_FILE}: key "A": needs at least one of "local", "production"`,
    ]);
  });

  test("an environment named like an object property is read only from the key", () => {
    const result = parseMap(
      `environments = ["constructor", "prod"]\n${VAULTS}[keys.A]\nprod = "op://Private/p/password"\n`,
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
      `environment "Prod": a name starts with a lowercase letter and uses only lowercase letters, digits and dashes`,
    ],
    [
      `environments = ["rotate_every"]`,
      `environment "rotate_every": a name starts with a lowercase letter and uses only lowercase letters, digits and dashes`,
    ],
    [`environments = ["dev", "dev"]`, `environment "dev" is listed twice`],
  ])("%s is rejected", (line, message) => {
    expect(errorsOf(`${line}\n`)).toEqual([`${MAP_FILE}: ${message}`]);
  });
});

describe("missing fields", () => {
  const base = {};
  const key = (fields: Record<string, string>) =>
    `${VAULTS}\n[keys.A]\n${Object.entries(fields)
      .map(([name, value]) => `${name} = ${value}`)
      .join("\n")}\n`;

  test.each([
    ["an environment", key(base), `key "A": needs at least one of "dev", "prod"`],
    ["from", key({ ...base, prod: "{ publish = [] }" }), `key "A" prod: missing field "from"`],
    [
      "worker",
      key({
        ...base,
        prod: '{ from = "op://Private/i/password", publish = [{ to = "cloudflare-worker", account = "11111111111111111111111111111111" }] }',
      }),
      `key "A" prod: publish[0]: missing field "worker"`,
    ],
    [
      "a Worker's account",
      key({
        ...base,
        prod: '{ from = "op://Private/i/password", publish = [{ to = "cloudflare-worker", worker = "w" }] }',
      }),
      `key "A" prod: publish[0]: missing field "account"`,
    ],
    [
      "repo",
      key({
        ...base,
        prod: '{ from = "op://Private/i/password", publish = [{ to = "github-actions" }] }',
      }),
      `key "A" prod: publish[0]: missing field "repo"`,
    ],
    [
      "to",
      key({ ...base, prod: '{ from = "op://Private/i/password", publish = [{ repo = "a/b" }] }' }),
      `key "A" prod: publish[0]: missing field "to"`,
    ],
  ])("%s", (_, text, message) => {
    expect(errorsOf(text)).toContain(`${MAP_FILE}: ${message}`);
  });

  test("the 1Password account", () => {
    expect(errorsOf(`[1password]\n`)).toEqual([
      `${MAP_FILE}: [1password]: missing field "account"`,
    ]);
    expect(errorsOf(`[keys.A]\ndev = "op://v/i/password"\n`)).toEqual([
      `${MAP_FILE}: key "A" dev: field "from" needs your 1Password account: add [1password] with account = "..."`,
    ]);
  });
});

describe("unknown fields are errors that name the file, the key and the field", () => {
  test.each([
    ["top level", `owner = "x"\n`, `unknown top-level field "owner"`],
    [
      "1password",
      `[1password]\naccount = "a"\ntoken = "x"\n`,
      `[1password]: unknown field "token"`,
    ],
    [
      "the old vault table",
      `[vaults.personal]\naccount = "a"\nvault = "v"\n`,
      `[vaults] is from keypin 0.4; use [1password] and op:// references (see docs/configuration.md for the current format)`,
    ],
    [
      "the old vault and item fields",
      `${VAULTS}[keys.A]\ndev = { from = "op://v/i/password", item = "i" }\n`,
      `key "A" dev: "vault" and "item" are from keypin 0.4; use from = "op://<vault>/<item>/<field>" (see docs/configuration.md for the current format)`,
    ],
    [
      "key",
      `${VAULTS}[keys.A]\nrotate = "90d"\ndev = "op://Private/i/password"\n`,
      `key "A": unknown field "rotate"; environments are "dev", "prod"`,
    ],
    [
      "environment name",
      `${VAULTS}[keys.A]\ndev = "op://Private/i/password"\nstaging = "op://Private/i/password"\n`,
      `key "A": unknown field "staging"; environments are "dev", "prod"`,
    ],
    [
      "environment",
      `${VAULTS}[keys.A]\ndev = { from = "op://Private/i/password", value = "x" }\n`,
      `key "A" dev: unknown field "value"`,
    ],
    [
      "Worker target",
      `${VAULTS}[keys.A]\nprod = { from = "op://Private/i/password", publish = [{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "w", repo = "x/y" }] }\n`,
      `key "A" prod: publish[0]: unknown field "repo" for cloudflare-worker`,
    ],
    [
      "GitHub target",
      `${VAULTS}[keys.A]\nprod = { from = "op://Private/i/password", publish = [{ to = "github-actions", repo = "x/y", environment = "production" }] }\n`,
      `key "A" prod: publish[0]: unknown field "environment" for github-actions`,
    ],
  ])("%s", (_, text, message) => {
    expect(errorsOf(text)).toEqual([`${MAP_FILE}: ${message}`]);
  });

  test("a keypin 0.6 github-actions account says the map pins only the repo", () => {
    const old = `${VAULTS}[keys.A]\nprod = { from = "op://Private/i/password", publish = [{ to = "github-actions", repo = "acme/billing", account = "alice" }] }\n`;
    const hint = `field "account" is from keypin 0.6; the map pins only repo = "owner/name", and each machine publishes as its own GitHub login (git config github.account, else the active gh login). Delete it (see docs/configuration.md for the current format)`;
    expect(errorsOf(old)).toEqual([`${MAP_FILE}: key "A" prod: publish[0]: ${hint}`]);
  });

  test("a github-actions destination pins the repo's owner as its account", () => {
    const result = parseMap(
      `${VAULTS}[keys.A]\nprod = { from = "op://Private/i/password", publish = [{ to = "github-actions", repo = "Acme/billing" }] }\n`,
      MAP_FILE,
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.map.keys[0]?.environments.prod?.publish).toEqual([
      { to: "github-actions", repo: "Acme/billing", account: "Acme" },
    ]);
  });

  test("a keypin 0.4 key with env says to name the table after the variable", () => {
    expect(errorsOf(`${VAULTS}[keys.A]\nenv = "A"\ndev = "op://Private/i/password"\n`)).toEqual([
      `${MAP_FILE}: key "A": field "env" is from keypin 0.4; name the table after the variable, such as [keys.API_TOKEN] (see docs/configuration.md for the current format)`,
    ]);
  });

  test("a removed field says to delete it", () => {
    expect(
      errorsOf(`${VAULTS}[keys.A]\nowner = "o"\nconsumers = []\ndev = "op://Private/i/password"\n`),
    ).toEqual([
      `${MAP_FILE}: key "A": field "owner" is no longer used; delete it`,
      `${MAP_FILE}: key "A": field "consumers" is no longer used; delete it`,
    ]);
  });
});

describe("wrong kinds and values", () => {
  test.each([
    [
      "destination",
      `{ to = "dotenv", path = ".env" }`,
      `key "A" prod: publish[0]: field "to" must be one of: cloudflare-worker, github-actions`,
    ],
    [
      "repo without an owner",
      `{ to = "github-actions", repo = "billing" }`,
      `key "A" prod: publish[0]: field "repo" must be "owner/name"`,
    ],
    [
      "duplicate destination",
      `{ to = "github-actions", repo = "a/b" }, { to = "github-actions", repo = "a/b" }`,
      `key "A" prod: publish[1]: the same destination as publish[0]`,
    ],
    [
      "non-string field",
      `{ to = "cloudflare-worker", account = 7, worker = "w" }`,
      `key "A" prod: publish[0]: field "account" must be a non-empty string`,
    ],
  ])("%s", (_, targets, message) => {
    const text = `${VAULTS}[keys.A]\nprod = { from = "op://Private/i/password", publish = [${targets}] }\n`;
    expect(errorsOf(text)).toEqual([`${MAP_FILE}: ${message}`]);
  });

  test("a reference names the vault, item, optional section and field", () => {
    const result = parseMap(
      `${VAULTS}[keys.A]\ndev = "op://App Secrets/stripe/credential"\nprod = { from = "op://Shared/stripe live/api/secret key" }\n`,
      MAP_FILE,
    );
    assert(result.ok, JSON.stringify(result));
    const { dev, prod } = result.map.keys[0]?.environments ?? {};
    expect(dev?.ref).toMatchObject({
      vault: "App Secrets",
      item: "stripe",
      section: null,
      field: "credential",
    });
    expect(prod?.ref).toMatchObject({
      vault: "Shared",
      item: "stripe live",
      section: "api",
      field: "secret key",
    });
  });

  test.each([
    ["Private/i/password", "must start with op://"],
    [
      "op://Private/i",
      "must be op://<vault>/<item>/<field> or op://<vault>/<item>/<section>/<field>",
    ],
    [
      "op://Private/i/a/b/c",
      "must be op://<vault>/<item>/<field> or op://<vault>/<item>/<section>/<field>",
    ],
    [
      "op://Private//password",
      "must be op://<vault>/<item>/<field> or op://<vault>/<item>/<section>/<field>",
    ],
    ["op://Private/i/password?attribute=otp", "can't have a query such as ?attribute="],
  ])("the reference %s is refused", (reference, message) => {
    expect(errorsOf(`${VAULTS}[keys.A]\ndev = "${reference}"\n`)).toEqual([
      `${MAP_FILE}: key "A" dev: field "from" ${message}`,
    ]);
  });

  test("a bad rotate_every, env name and key ID", () => {
    expect(
      errorsOf(`${VAULTS}[keys.MY-KEY]\nrotate_every = "soon"\ndev = "op://Private/i/password"\n`),
    ).toEqual([
      `${MAP_FILE}: keys[0]: the table name is the variable your program reads: letters, digits and _, not starting with a digit`,
      `${MAP_FILE}: keys[0]: field "rotate_every" must be <n>d, <n>w, <n>m or never`,
    ]);
  });

  test("a GITHUB_ name can't go to github-actions, in any case", () => {
    for (const env of ["GITHUB_TOKEN", "github_app_key"]) {
      expect(
        errorsOf(
          `${VAULTS}[keys.${env}]\ndev = "op://Private/i/password"\nprod = { from = "op://Private/i/password", publish = [{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "w" }, { to = "github-actions", repo = "a/b" }] }\n`,
        ),
      ).toEqual([
        `${MAP_FILE}: key "${env}" prod: publish[1]: github-actions can't take this key, because GitHub reserves secret names that start with GITHUB_`,
      ]);
    }
  });

  test("a GITHUB_ name is fine anywhere else", () => {
    const result = parseMap(
      `${VAULTS}[keys.GITHUB_TOKEN]\ndev = "op://Private/i/password"\nprod = { from = "op://Private/i/password", publish = [{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "w" }] }\n`,
      MAP_FILE,
    );
    expect(result.ok).toBe(true);
  });

  test("a duplicate names the first valid entry it repeats, by its place in the map", () => {
    const worker = (name: string) =>
      `{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "${name}" }`;
    const prod = (targets: string[]) =>
      `${VAULTS}[keys.A]\nprod = { from = "op://Private/i/password", publish = [${targets.join(", ")}] }\n`;
    expect(errorsOf(prod([worker("x"), worker("x"), worker("y"), worker("y")]))).toEqual([
      `${MAP_FILE}: key "A" prod: publish[1]: the same destination as publish[0]`,
      `${MAP_FILE}: key "A" prod: publish[3]: the same destination as publish[2]`,
    ]);
    expect(errorsOf(prod(["{}", worker("x"), worker("x")]))).toEqual([
      `${MAP_FILE}: key "A" prod: publish[0]: missing field "to"`,
      `${MAP_FILE}: key "A" prod: publish[2]: the same destination as publish[1]`,
    ]);
  });

  test("one destination secret can't belong to two keys, or to a key's dev and prod", () => {
    const repo = `{ to = "github-actions", repo = "acme/billing" }`;
    const twoKeys = `${VAULTS}[keys.API_TOKEN]\nprod = { from = "op://Private/a/password", publish = [${repo}] }\n[keys.api_token]\nprod = { from = "op://Private/b/password", publish = [${repo}] }\n`;
    expect(errorsOf(twoKeys)).toEqual([
      `${MAP_FILE}: key "api_token" prod publish[0]: writes the same destination secret as key "API_TOKEN" prod publish[0]`,
    ]);
    const devAndProd = `${VAULTS}[keys.DEPLOY_TOKEN]\ndev = { from = "op://Private/b/password", publish = [${repo}] }\nprod = { from = "op://Private/a/password", publish = [${repo}] }\n`;
    expect(errorsOf(devAndProd)).toEqual([
      `${MAP_FILE}: key "DEPLOY_TOKEN" prod publish[0]: writes the same destination secret as key "DEPLOY_TOKEN" dev publish[0]`,
    ]);
  });

  test("a Worker's account is a Cloudflare account ID", () => {
    expect(
      errorsOf(
        `${VAULTS}[keys.A]\nprod = { from = "op://Private/i/password", publish = [{ to = "cloudflare-worker", account = "me@example.com", worker = "w" }] }\n`,
      ),
    ).toEqual([
      `${MAP_FILE}: key "A" prod: publish[0]: field "account" must be a Cloudflare account ID (32 hex characters)`,
    ]);
  });

  test("a GitHub repo compares without case, like GitHub", () => {
    const target = (repo: string) => `{ to = "github-actions", repo = "${repo}" }`;
    expect(
      errorsOf(
        `${VAULTS}[keys.TOKEN]\nprod = { from = "op://Private/a/password", publish = [${target("acme/billing")}] }\n[keys.token]\nprod = { from = "op://Private/b/password", publish = [${target("Acme/Billing")}] }\n`,
      ),
    ).toEqual([
      `${MAP_FILE}: key "token" prod publish[0]: writes the same destination secret as key "TOKEN" prod publish[0]`,
    ]);
  });

  test("the same Worker and secret name in two Cloudflare accounts are two secrets", () => {
    const worker = (account: string) =>
      `{ to = "cloudflare-worker", account = "${account.repeat(8)}", worker = "api" }`;
    const result = parseMap(
      `${VAULTS}[keys.TOKEN]\ndev = { from = "op://Private/d/password", publish = [${worker("aaaa")}] }\nprod = { from = "op://Private/p/password", publish = [${worker("bbbb")}] }\n`,
      MAP_FILE,
    );
    expect(result.ok).toBe(true);
  });

  test("the same secret name in two Workers, or another case of a Worker secret, is fine", () => {
    const worker = (name: string) =>
      `{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "${name}" }`;
    const result = parseMap(
      `${VAULTS}[keys.TOKEN]\ndev = { from = "op://Private/a/password", publish = [${worker("one")}] }\nprod = { from = "op://Private/b/password", publish = [${worker("two")}] }\n[keys.token]\nprod = { from = "op://Private/c/password", publish = [${worker("one")}] }\n`,
      MAP_FILE,
    );
    expect(result.ok).toBe(true);
  });

  test("publish must be a list", () => {
    expect(
      errorsOf(
        `${VAULTS}[keys.A]\nprod = { from = "op://Private/i/password", publish = { to = "github-actions", repo = "a/b" } }\n`,
      ),
    ).toEqual([`${MAP_FILE}: key "A" prod: field "publish" must be a list`]);
  });

  test("invalid TOML names the file", () => {
    const [error] = errorsOf(`env = "A"\nenv = "B"\n`);
    expect(error).toMatch(new RegExp(`^${MAP_FILE}: not valid TOML: `));
  });

  test("no error quotes the text it found, so a value pasted by mistake stays out of the output", () => {
    const pasted = "sentinel-pasted-value-5555";
    const target = (fields: string) =>
      `${VAULTS}[keys.A]\nprod = { from = "op://Private/i/password", publish = [${fields}] }\n`;
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
      `${VAULTS}[keys.${pasted}]\ndev = "op://Private/i/password"\n`,
      `${VAULTS}[keys.A]\nrotate_every = "${pasted}"\ndev = "op://Private/i/password"\n`,
      `${VAULTS}[keys.A]\ndev = "${pasted}"\n`,
      `${VAULTS}[keys.A]\ndev = "op://${pasted}"\n`,
      `[1password]\naccount = 7\n`,
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
      `${MAP_FILE}: not valid TOML: Expected a value, and strings must be quoted`,
    ]);
    expect(errorsOf(`[a]\nb = 1\n[a]\n`)).toEqual([
      `${MAP_FILE}: not valid TOML: Trying to redefine an already defined table or value`,
    ]);
    expect(errorsOf(`k = \u00e9x\n`)).toEqual([
      `${MAP_FILE}: not valid TOML: Expected a value, and strings must be quoted`,
    ]);
    expect(errorsOf(`k = "\u0001x"\n`)).toEqual([
      `${MAP_FILE}: not valid TOML: Control characters are not allowed in strings`,
    ]);
    expect(errorsOf(`k = "a" b\n`)).toEqual([
      `${MAP_FILE}: not valid TOML: Each key-value declaration must be followed by an end-of-line`,
    ]);
  });

  test("every error is reported, not just the first", () => {
    expect(errorsOf(`${VAULTS}[keys.A]\nrotate = "1d"\n\n[keys.b-c]\n`)).toHaveLength(4);
  });
});

describe("a rotate section", () => {
  const ACCOUNT = "e48c9afabc4ff0cda321d0cf69b8943f";
  const mapWith = (fields: string, section = "rotate") => `${VAULTS}
[keys.CLOUDFLARE_API_TOKEN]

[keys.CLOUDFLARE_API_TOKEN.prod]
from = "op://Private/site deploy token/password"

[keys.CLOUDFLARE_API_TOKEN.prod.${section}]
${fields}
`;

  test("names the provider, the account and the admin token's reference", () => {
    const result = parseMap(
      mapWith(
        `provider = "cloudflare-account-token"\naccount = "${ACCOUNT}"\nadmin = "op://Private/shared cloudflare token admin/password"`,
      ),
      MAP_FILE,
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.map.keys[0]?.environments.prod?.rotate).toEqual({
      provider: "cloudflare-account-token",
      account: ACCOUNT,
      admin: {
        kind: "1password",
        account: "my.1password.com",
        vault: "Private",
        item: "shared cloudflare token admin",
        section: null,
        field: "password",
      },
    });
  });

  test("an entry without one has no rotate", () => {
    const result = parseMap(VALID_MAP, MAP_FILE);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.map.keys[0]?.environments.prod).not.toHaveProperty("rotate");
  });

  test("the keypin 0.5 issue section says to rename it to rotate", () => {
    expect(
      errorsOf(
        mapWith(
          `provider = "cloudflare-account-token"\naccount = "${ACCOUNT}"\nadmin = "op://Private/a/password"`,
          "issue",
        ),
      ),
    ).toEqual([
      `${MAP_FILE}: key "CLOUDFLARE_API_TOKEN" prod: the "issue" section is from keypin 0.5; rename it to "rotate" (see docs/configuration.md for the current format)`,
    ]);
  });

  test.each([
    [`account = "${ACCOUNT}"\nadmin = "op://Private/a/password"`, `missing field "provider"`],
    [
      `provider = "aws-iam-key"\naccount = "${ACCOUNT}"\nadmin = "op://Private/a/password"`,
      `field "provider" must be one of: cloudflare-account-token`,
    ],
    [
      `provider = "cloudflare-account-token"\naccount = "personal"\nadmin = "op://Private/a/password"`,
      `field "account" must be a Cloudflare account ID (32 hex characters)`,
    ],
    [
      `provider = "cloudflare-account-token"\naccount = "${ACCOUNT}"\nadmin = "op://Private/site deploy token/credential"`,
      `field "admin" names the key's own item; the admin token needs its own item`,
    ],
    [
      `provider = "cloudflare-account-token"\naccount = "${ACCOUNT}"\nadmin = "op://private/Site Deploy Token/credential"`,
      `field "admin" names the key's own item; the admin token needs its own item`,
    ],
    [
      `provider = "cloudflare-account-token"\naccount = "${ACCOUNT}"\nadmin = "op://Private/a/password"\npermissions = []`,
      `unknown field "permissions"`,
    ],
  ])("%s is refused", (fields, message) => {
    expect(errorsOf(mapWith(fields))).toEqual([
      `${MAP_FILE}: key "CLOUDFLARE_API_TOKEN" prod: rotate: ${message}`,
    ]);
  });
});

describe("shared targets from keypin 0.6", () => {
  const CI = `[targets.ci]\nto = "github-actions"\nrepo = "acme/api"\n`;
  const withPublish = (targets: string, publish: string) =>
    `${VAULTS}${targets}\n[keys.API_TOKEN]\nprod = { from = "op://Private/i/password", publish = [${publish}] }\n`;
  const TARGETS = `${MAP_FILE}: shared [targets] are no longer supported; write each destination inline under [[keys.<VARIABLE>.<env>.publish]] (see docs/configuration.md for the current format)`;
  const NAMED = (i: number) =>
    `${MAP_FILE}: key "API_TOKEN" prod: publish[${i}]: names a shared target, which is no longer supported; write the destination inline, such as { to = "github-actions", repo = "owner/name" } (see docs/configuration.md for the current format)`;

  test("a map with [targets] and a publish entry that names one says to write it inline", () => {
    expect(errorsOf(withPublish(CI, `"ci"`))).toEqual([TARGETS, NAMED(0)]);
  });

  test("a publish entry that names a target fails even without [targets]", () => {
    expect(errorsOf(withPublish("", `{ to = "github-actions", repo = "acme/web" }, "ci"`))).toEqual(
      [NAMED(1)],
    );
  });

  test("[targets] fails whatever it holds", () => {
    expect(errorsOf(`targets = ["ci"]\n${VAULTS}`)).toEqual([TARGETS]);
  });

  test("a publish entry that is neither a table nor a string must be a table", () => {
    expect(errorsOf(withPublish("", `7`))).toEqual([
      `${MAP_FILE}: key "API_TOKEN" prod: publish[0]: must be a table`,
    ]);
  });

  test("the error never quotes the name it found", () => {
    const pasted = "sentinel-pasted-value-5555";
    const errors = errorsOf(
      withPublish(`[targets."${pasted}"]\nto = "github-actions"\nrepo = "a/b"\n`, `"${pasted}"`),
    ).join("\n");
    expect(errors).not.toContain(pasted);
    expect(errors.toLowerCase()).not.toContain("sentinel");
  });
});
