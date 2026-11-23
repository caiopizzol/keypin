import { assert, describe, expect, test } from "vite-plus/test";
import { publishEnvironment, runEnvironment } from "../src/index";
import { MAP_FILE } from "./fixtures";
import { errorsOf, HEAD, read } from "./secretspec";

function refOf(text: string, name: string, profile: string) {
  const result = read(text);
  assert(result.ok, JSON.stringify(result));
  return result.map.keys.find((key) => key.name === name)?.environments[profile]?.ref;
}

const item = (title: string, more: Record<string, unknown> = {}) => ({
  kind: "1password",
  account: "my.1password.com",
  vault: "Acme",
  item: title,
  section: null,
  ...more,
});

describe("the plan's example", () => {
  const EXAMPLE = `${HEAD}
[profiles.default]
STRIPE_KEY = { description = "Stripe test key" }

[profiles.production]
RESEND_API_KEY = { description = "Resend", ref = { item = "resend key", field = "credential" } }

[tool.keypin]
ignore = ["KEYPIN_GITHUB_TOKEN", "OP_SERVICE_ACCOUNT_TOKEN"]

[tool.keypin.production.RESEND_API_KEY]
rotate_every = "90d"
publish = [{ to = "github-actions", repo = "acme/web" }]
issuer = { kind = "resend", admin = "op://Acme/resend admin/credential", permission = "sending_access" }
`;

  test("reads profiles in file order, every secret's place, and keypin's settings", () => {
    const result = read(EXAMPLE);
    assert(result.ok, JSON.stringify(result));
    expect(result.map).toEqual({
      file: MAP_FILE,
      project: "web",
      environments: ["default", "production"],
      ignore: ["KEYPIN_GITHUB_TOKEN", "OP_SERVICE_ACCOUNT_TOKEN"],
      keys: [
        {
          name: "STRIPE_KEY",
          rotateEvery: null,
          environments: {
            default: {
              ref: item("secretspec/web/default/STRIPE_KEY", {
                field: "value",
                fallback: "password",
              }),
              publish: [],
            },
            production: {
              ref: item("secretspec/web/production/STRIPE_KEY", {
                field: "value",
                fallback: "password",
              }),
              publish: [],
            },
          },
        },
        {
          name: "RESEND_API_KEY",
          rotateEvery: { text: "90d", days: 90 },
          environments: {
            production: {
              ref: item("resend key", { field: "credential" }),
              publish: [{ to: "github-actions", repo: "acme/web", account: "acme" }],
              issuer: {
                kind: "resend",
                admin: item("resend admin", { field: "credential" }),
                permission: "sending_access",
              },
            },
          },
        },
      ],
    });
  });

  test("run uses default and publish uses production", () => {
    const result = read(EXAMPLE);
    assert(result.ok);
    expect([runEnvironment(result.map), publishEnvironment(result.map)]).toEqual([
      "default",
      "production",
    ]);
  });

  test("without them, run uses the first profile and publish the last", () => {
    const result = read(`${HEAD}\n[profiles.dev]\n\n[profiles.staging]\n\n[profiles.live]\n`);
    assert(result.ok);
    expect([runEnvironment(result.map), publishEnvironment(result.map)]).toEqual(["dev", "live"]);
  });

  test("a file saved with a byte order mark reads the same", () => {
    expect(read(`﻿${EXAMPLE}`)).toEqual(read(EXAMPLE));
  });
});

describe("profiles", () => {
  test("a profile inherits default's secrets, and its own entry overrides field by field", () => {
    const text = `${HEAD}
[profiles.default]
A = { description = "a", ref = { item = "shared a" } }
B = { description = "b" }

[profiles.production]
A = { description = "a in production" }
`;
    expect(refOf(text, "A", "production")).toEqual(
      item("shared a", { field: "value", fallback: "password" }),
    );
    expect(refOf(text, "B", "production")?.item).toBe("secretspec/web/production/B");
  });

  test("an own ref replaces the inherited one", () => {
    const text = `${HEAD}
[profiles.default]
A = { description = "a", ref = { item = "dev a", field = "password" } }

[profiles.production]
A = { ref = { item = "live a", field = "credential" } }
`;
    expect(refOf(text, "A", "default")?.item).toBe("dev a");
    expect(refOf(text, "A", "production")).toEqual(item("live a", { field: "credential" }));
  });

  test("inherit = false leaves default's secrets out", () => {
    const text = `${HEAD}
[profiles.default]
A = { description = "a" }

[profiles.deploy.defaults]
inherit = false

[profiles.deploy]
B = { description = "b" }
`;
    const result = read(text);
    assert(result.ok);
    expect(result.map.keys.map((key) => [key.name, Object.keys(key.environments)])).toEqual([
      ["A", ["default"]],
      ["B", ["deploy"]],
    ]);
  });

  test("a secret derived from others has no vault item, so keypin leaves it out", () => {
    const text = `${HEAD}
[profiles.default]
DB_PASSWORD = { description = "password" }
DATABASE_URL = { description = "url", composed = "postgres://app:\${DB_PASSWORD}@db/app" }
`;
    const result = read(text);
    assert(result.ok);
    expect(result.map.keys.map((key) => key.name)).toEqual(["DB_PASSWORD"]);
    expect(errorsOf(`${text}\n[tool.keypin.default.DATABASE_URL]\nrotate_every = "90d"\n`)).toEqual(
      [
        `${MAP_FILE}: [tool.keypin.default.DATABASE_URL]: DATABASE_URL is derived from other secrets, so no vault holds it for keypin to publish or rotate`,
      ],
    );
  });

  test.each([
    [
      "no [project] name",
      `[profiles.default]\n`,
      `${MAP_FILE}: [project] needs name, such as name = "web"`,
    ],
    [
      "extends",
      `[project]\nname = "web"\nrevision = "1.0"\nextends = ["../shared"]\n\n[profiles.default]\n`,
      `${MAP_FILE}: [project]: keypin doesn't read extends yet; declare the secrets in this file`,
    ],
    [
      "no profile",
      `[project]\nname = "web"\nrevision = "1.0"\n`,
      `${MAP_FILE}: needs a profile, such as [profiles.default]`,
    ],
    [
      "a profile name keypin can't use",
      `${HEAD}\n[profiles.Prod]\n`,
      `${MAP_FILE}: [profiles.Prod]: keypin needs a profile name that starts with a lowercase letter and uses only lowercase letters, digits and dashes`,
    ],
    [
      "a secret that isn't a table",
      `${HEAD}\n[profiles.default]\nA = "op://Acme/a/password"\n`,
      `${MAP_FILE}: [profiles.default] A: must be a table, such as { description = "..." }`,
    ],
    [
      "invalid TOML",
      `${HEAD}\n[profiles.default\n`,
      `${MAP_FILE}: not valid TOML: Illegal character in key`,
    ],
  ])("refuses %s", (_, text, error) => {
    expect(errorsOf(text)).toEqual([error]);
  });

  test("a TOML error drops the text it found, so a pasted value stays out of the output", () => {
    const pasted = "sk_live_sentinel_51H";
    const [error = ""] = errorsOf(`${HEAD}\n[profiles.default]\nA = ${pasted}\n`);
    expect(error).not.toContain(pasted);
  });
});

describe("where a secret lives", () => {
  const secret = (entry: string, extra = "") =>
    `${HEAD}${extra}\n[profiles.production]\nA = { description = "a"${entry} }\n`;

  test("the secret's providers come first, then the profile's, then the project's", () => {
    const providers = `\n[providers.ops]\nuri = "onepassword://ops.1password.com@Ops"\n`;
    expect(refOf(secret(`, providers = ["ops"]`, providers), "A", "production")).toMatchObject({
      account: "ops.1password.com",
      vault: "Ops",
    });
    const profile = `\n[profiles.production.defaults]\nproviders = ["onepassword://team.1password.com@Team"]\n`;
    expect(refOf(`${secret("")}${profile}`, "A", "production")).toMatchObject({
      account: "team.1password.com",
      vault: "Team",
    });
    expect(refOf(secret(""), "A", "production")).toMatchObject({ vault: "Acme" });
  });

  test("keypin reads the first provider of the chain", () => {
    expect(
      refOf(
        secret(`, providers = ["acme", "onepassword://x.1password.com@Other"]`),
        "A",
        "production",
      ),
    ).toMatchObject({ vault: "Acme" });
  });

  test.each([
    ["a scalar", `, providers = "ops"`, "", "providers"],
    ["an empty list", `, providers = []`, "", "providers"],
    [
      "a scalar in the profile's defaults",
      "",
      `\n[profiles.production.defaults]\nproviders = "ops"\n`,
      "[profiles.production.defaults] providers",
    ],
  ])(
    "refuses %s as providers, instead of falling back to the project's",
    (_, entry, extra, name) => {
      expect(errorsOf(`${secret(entry)}${extra}`)).toEqual([
        `${MAP_FILE}: [profiles.production] A: ${name} must be a list of provider names, such as ["acme"]`,
      ]);
    },
  );

  test.each([
    [
      "an alias defined only in a user's own config",
      secret(`, providers = ["mine"]`),
      `provider "mine" isn't under [providers] in secretspec.toml, so CI and the console can't find its vault; define it there`,
    ],
    [
      "no provider at all",
      `[project]\nname = "web"\nrevision = "1.0"\n\n[profiles.production]\nA = { description = "a" }\n`,
      `names no provider in secretspec.toml, so CI and the console can't find its vault; add providers = ["..."] to it, or set [defaults] providers`,
    ],
    [
      "a provider keypin can't read",
      secret(`, providers = ["keyring://"]`),
      `uses keyring://, and keypin reads only 1Password from secretspec.toml`,
    ],
    [
      "a vault keypin reads, but not from secretspec.toml yet",
      secret(`, providers = ["infisical://app.infisical.com"]`),
      `uses infisical://app.infisical.com; keypin doesn't read Infisical from secretspec.toml yet`,
    ],
    [
      "refs",
      secret(`, refs = { acme = { item = "a" } }`),
      `keypin doesn't read refs yet; give the secret one ref = { item = "..." }`,
    ],
    [
      "an alias with a ref template, for a secret without its own ref",
      `${HEAD.replace(
        `acme = "onepassword://my.1password.com@Acme"`,
        `acme = { uri = "onepassword://my.1password.com@Acme", ref = { item = "{project} {key}" } }`,
      )}\n[profiles.production]\nA = { description = "a" }\n`,
      `provider "acme" has a ref template, and keypin doesn't read ref templates yet; give the secret its own ref`,
    ],
  ])("refuses %s", (_, text, error) => {
    expect(errorsOf(text)).toEqual([`${MAP_FILE}: [profiles.production] A: ${error}`]);
  });

  test("a secret's own ref wins over its alias's ref template, as in secretspec", () => {
    const text = `${HEAD.replace(
      `acme = "onepassword://my.1password.com@Acme"`,
      `acme = { uri = "onepassword://my.1password.com@Acme", ref = { item = "{key}" } }`,
    )}\n[profiles.production]\nA = { description = "a", ref = { item = "own a", field = "password" } }\n`;
    expect(refOf(text, "A", "production")?.item).toBe("own a");
  });
});

describe("1Password", () => {
  const at = (uri: string, ref = "") =>
    `[project]\nname = "web"\nrevision = "1.0"\n\n[profiles.production]\nA = { description = "a", providers = [${JSON.stringify(uri)}]${ref} }\n`;
  const one = (text: string) => {
    const [error = ""] = errorsOf(text);
    return error.replace(`${MAP_FILE}: [profiles.production] A: `, "");
  };

  test("without ref, reads secretspec's item for the profile, field value then password", () => {
    expect(refOf(at("onepassword://my.1password.com@Acme"), "A", "production")).toEqual(
      item("secretspec/web/production/A", { field: "value", fallback: "password" }),
    );
  });

  test("a ref names the item, and optionally its field, section and vault", () => {
    const uri = "onepassword://my.1password.com@Acme";
    expect(refOf(at(uri, `, ref = { item = "db" }`), "A", "production")).toEqual(
      item("db", { field: "value", fallback: "password" }),
    );
    expect(
      refOf(
        at(uri, `, ref = { vault = "Infra", item = "db", section = "live", field = "url" }`),
        "A",
        "production",
      ),
    ).toEqual(item("db", { vault: "Infra", section: "live", field: "url" }));
  });

  test("an item title may hold /, and the URI may be percent-encoded", () => {
    expect(
      refOf(
        at("onepassword://my.1password.com@Team%20Keys", `, ref = { item = "a/b/c" }`),
        "A",
        "production",
      ),
    ).toMatchObject({ vault: "Team Keys", item: "a/b/c" });
  });

  test.each([
    ["onepassword://Acme", "doesn't name the 1Password account"],
    ["onepassword://my.1password.com@", "doesn't name the 1Password account"],
    ["onepassword://", "doesn't name the 1Password account"],
    ["onepassword://my.1password.com@Acme/item/field", "names more than a vault"],
    ["onepassword+token://Acme", "a onepassword+token:// provider, which keypin doesn't read yet"],
  ])("refuses %s", (uri, problem) => {
    expect(one(at(uri))).toContain(problem);
  });

  test("a refused token URI stays out of the output", () => {
    const token = "ops_sentinel_51H";
    expect(one(at(`onepassword+token://${token}@Acme`))).not.toContain(token);
  });

  test("the account message says what to write", () => {
    expect(one(at("onepassword://Acme"))).toBe(
      `uses onepassword://Acme, which doesn't name the 1Password account; write onepassword://<sign-in address>@<vault>, with the sign-in address at the top left of the 1Password app (such as my.1password.com) or the account ID`,
    );
  });

  test.each([
    [`, ref = { field = "x" }`, `field "ref" needs item, the 1Password item's title or ID`],
    [
      `, ref = { item = "a", label = "x" }`,
      `field "ref" has the unknown field "label"; a 1Password ref has item, field, section and vault`,
    ],
    [`, ref = { item = "a", section = "s" }`, `field "ref" names a section, so it needs field too`],
    [
      `, ref = { item = "a", field = "" }`,
      `field "ref" holds item, field, section and vault as non-empty strings`,
    ],
    [`, ref = "op://Acme/a/password"`, `field "ref" must be a table, such as { item = "..." }`],
  ])("refuses the ref %s", (ref, problem) => {
    expect(one(at("onepassword://my.1password.com@Acme", ref))).toBe(problem);
  });
});
