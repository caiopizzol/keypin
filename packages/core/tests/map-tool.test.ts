import { assert, describe, expect, test } from "vite-plus/test";
import { type IssuerKind, type IssuerSpec, readSecretspec } from "../src/index";
import { ISSUERS, KINDS, MAP_FILE, VAULT_KINDS } from "./fixtures";
import { errorsOf, HEAD, read } from "./secretspec";

const PROFILES = `${HEAD}
[profiles.default]
API_KEY = { description = "API key", ref = { item = "api key", field = "credential" } }

[profiles.production]
RESEND_API_KEY = { description = "Resend", ref = { item = "resend key", field = "credential" } }
`;

const WORKER = `{ to = "cloudflare-worker", account = "11111111111111111111111111111111", worker = "api" }`;
const GITHUB = `{ to = "github-actions", repo = "acme/web" }`;

const tool = (table: string, profile = "production", key = "RESEND_API_KEY") =>
  `${PROFILES}\n[tool.keypin.${profile}.${key}]\n${table}\n`;

const where = (profile = "production", key = "RESEND_API_KEY") =>
  `${MAP_FILE}: [tool.keypin.${profile}.${key}]: `;

describe("[tool.keypin]", () => {
  test("a key without keypin settings still has its place, with nothing to publish", () => {
    const result = read(PROFILES);
    assert(result.ok, JSON.stringify(result));
    expect(result.map.keys.map((key) => [key.name, Object.keys(key.environments)])).toEqual([
      ["API_KEY", ["default", "production"]],
      ["RESEND_API_KEY", ["production"]],
    ]);
    expect(result.map.keys[0]?.environments.production).toMatchObject({ publish: [] });
  });

  test("an inherited key takes settings in the profile that inherits it", () => {
    const result = read(tool(`publish = [${GITHUB}]`, "production", "API_KEY"));
    assert(result.ok, JSON.stringify(result));
    expect(result.map.keys[0]?.environments.default?.publish).toEqual([]);
    expect(result.map.keys[0]?.environments.production?.publish).toEqual([
      { to: "github-actions", repo: "acme/web", account: "acme" },
    ]);
  });

  test.each([
    [
      "a profile that isn't declared",
      `${PROFILES}\n[tool.keypin.staging.API_KEY]\nrotate_every = "90d"\n`,
      `${MAP_FILE}: [tool.keypin.staging]: secretspec.toml has no [profiles.staging]`,
    ],
    [
      "a key that isn't declared in the profile",
      tool(`rotate_every = "90d"`, "default", "RESEND_API_KEY"),
      `${where("default")}RESEND_API_KEY isn't a secret of [profiles.default]; declare it there or in [profiles.default]`,
    ],
    [
      "an unknown field",
      tool(`rotate_every = "90d"\nfrom = "op://Acme/resend key/credential"`),
      `${where()}unknown field "from"`,
    ],
    [
      "a bad rotate_every",
      tool(`rotate_every = "soon"`),
      `${where()}field "rotate_every" must be <n>d, <n>w, <n>m or never`,
    ],
    [
      "a key's settings that aren't a table",
      `${PROFILES}\n[tool.keypin.production]\nRESEND_API_KEY = "90d"\n`,
      `${where()}must be a table with "rotate_every", "publish", "issuer", "name"`,
    ],
    [
      "a profile's settings that aren't a table",
      `${PROFILES}\n[tool.keypin]\nproduction = 1\n`,
      `${MAP_FILE}: [tool.keypin.production]: must be a table of keys, such as [tool.keypin.production.API_KEY]`,
    ],
  ])("refuses %s", (_, text, error) => {
    expect(errorsOf(text)).toEqual([error]);
  });

  test.each([
    ["rotate_every", `"90d"`],
    ["publish", `[${GITHUB}]`],
    ["issuer", `{ kind = "resend" }`],
    ["name", `"acme-web-mail"`],
  ])("refuses %s inside a secret's entry", (setting, value) => {
    const text = `${HEAD}\n[profiles.production]\nAPI_KEY = { description = "API key", ${setting} = ${value} }\n`;
    expect(errorsOf(text)).toEqual([
      `${MAP_FILE}: [profiles.production] API_KEY: "${setting}" is a keypin setting, and secretspec drops it from a secret; move it to [tool.keypin.production.API_KEY]`,
    ]);
  });

  test("one key rotates on one schedule", () => {
    const both = (other: string) =>
      `${PROFILES}\n[tool.keypin.default.API_KEY]\nrotate_every = "90d"\n\n[tool.keypin.production.API_KEY]\nrotate_every = "${other}"\n`;
    expect(errorsOf(both("30d"))).toEqual([
      `${where("production", "API_KEY")}rotate_every "30d" differs from [tool.keypin.default.API_KEY]'s "90d"; a key rotates on one schedule, so set the same rotate_every, or set it once`,
    ]);
    const same = read(both("90d"));
    assert(same.ok);
    expect(same.map.keys[0]?.rotateEvery).toEqual({ text: "90d", days: 90 });
  });

  test("rotate_every set in one profile is the key's", () => {
    const result = read(tool(`rotate_every = "3m"`, "production", "API_KEY"));
    assert(result.ok);
    expect(result.map.keys[0]?.rotateEvery).toEqual({ text: "3m", days: 90 });
  });

  test("every error is reported, not just the first", () => {
    expect(
      errorsOf(`${tool(`rotate_every = "soon"`)}\n[tool.keypin.staging.X]\nrotate_every = "1d"\n`),
    ).toHaveLength(2);
  });
});

describe("ignore", () => {
  const ignoring = (list: string) => `${PROFILES}\n[tool.keypin]\nignore = ${list}\n`;

  test("lists variable names that check leaves alone", () => {
    const result = read(ignoring(`["OPENAI_API_KEY"]`));
    assert(result.ok);
    expect(result.map.ignore).toEqual(["OPENAI_API_KEY"]);
  });

  test.each([
    [`"OPENAI_API_KEY"`, `"ignore" must be a list of variable names, such as ["OPENAI_API_KEY"]`],
    [
      `["1PASSWORD"]`,
      `ignore "1PASSWORD": a variable name uses letters, digits and _, not starting with a digit`,
    ],
    [`["A", "a"]`, `ignore "a" is listed twice`],
    [
      `["api_key"]`,
      `ignore "api_key" is also a secret in secretspec.toml; remove it from one of them`,
    ],
  ])("refuses %s", (list, error) => {
    expect(errorsOf(ignoring(list))).toEqual([`${MAP_FILE}: [tool.keypin] ${error}`]);
  });
});

describe("scan_files", () => {
  const scanning = (list: string) => `${PROFILES}\n[tool.keypin]\nscan_files = ${list}\n`;

  test("is null when unset, so check reads every file", () => {
    const result = read(PROFILES);
    assert(result.ok);
    expect(result.map.scanFiles).toBeNull();
  });

  test.each([[`[]`], [`[".github/workflows/billing-*.yml", "apps/api/wrangler.toml"]`]])(
    "lists globs from the repo root: %s",
    (list) => {
      const result = read(scanning(list));
      assert(result.ok);
      expect(result.map.scanFiles).toEqual(JSON.parse(list));
    },
  );

  test.each([[`".github/workflows/deploy.yml"`], [`[""]`], [`[1]`]])("refuses %s", (list) => {
    expect(errorsOf(scanning(list))).toEqual([
      `${MAP_FILE}: [tool.keypin] "scan_files" must be a list of file globs from the repo root`,
    ]);
  });
});

describe("publish", () => {
  test("must be a list of destination tables", () => {
    expect(errorsOf(tool(`publish = ${GITHUB}`))).toEqual([
      `${where()}field "publish" must be a list`,
    ]);
    expect(errorsOf(tool(`publish = ["github"]`))).toEqual([
      `${where()}publish[0]: must be a table`,
    ]);
    expect(errorsOf(tool(`publish = [{ to = "vercel" }]`))).toEqual([
      `${where()}publish[0]: field "to" must be one of: cloudflare-worker, github-actions`,
    ]);
  });

  test("a duplicate names the first entry it repeats", () => {
    expect(
      errorsOf(
        tool(`publish = [${GITHUB}, ${WORKER}, { to = "github-actions", repo = "acme/web" }]`),
      ),
    ).toEqual([`${where()}publish[2]: the same destination as publish[0]`]);
  });

  test("a GITHUB_ name can't go to github-actions", () => {
    const text = `${HEAD}\n[profiles.production]\nGITHUB_PAT = { description = "pat" }\n\n[tool.keypin.production.GITHUB_PAT]\npublish = [${GITHUB}]\n`;
    expect(errorsOf(text)).toEqual([
      `${where("production", "GITHUB_PAT")}publish[0]: github-actions can't take this key, because GitHub reserves secret names that start with GITHUB_`,
    ]);
  });

  test("one destination secret can't belong to two profiles of a key", () => {
    const text = `${PROFILES}\n[tool.keypin.default.API_KEY]\npublish = [${GITHUB}]\n\n[tool.keypin.production.API_KEY]\npublish = [${GITHUB}]\n`;
    expect(errorsOf(text)).toEqual([
      `${MAP_FILE}: [tool.keypin.production.API_KEY] publish[0]: writes the same destination secret as [tool.keypin.default.API_KEY] publish[0]`,
    ]);
  });
});

describe("pull", () => {
  test("is an unknown field now that secretspec run reads keys at job time", () => {
    expect(errorsOf(tool(`pull = [{ by = "github-actions", repo = "acme/web" }]`))).toEqual([
      `${where()}unknown field "pull"`,
    ]);
  });
});

describe("issuer", () => {
  const KIND = `kind = "resend", admin = "op://Acme/resend admin/credential"`;
  const issuer = (fields: string) => tool(`issuer = { ${fields} }`);

  test("pins the admin key to the key's own 1Password account", () => {
    const result = read(issuer(`${KIND}, permission = "full_access"`));
    assert(result.ok, JSON.stringify(result));
    expect(result.map.keys[1]?.environments.production?.issuer).toEqual({
      kind: "resend",
      admin: {
        kind: "1password",
        account: "my.1password.com",
        vault: "Acme",
        item: "resend admin",
        section: null,
        field: "credential",
      },
      permission: "full_access",
    });
  });

  test("a name is what the issuer calls new keys, before the run's tag", () => {
    const result = read(
      tool(`name = "acme-web-mail"\nissuer = { ${KIND}, permission = "full_access" }`),
    );
    assert(result.ok, JSON.stringify(result));
    expect(result.map.keys[1]?.environments.production?.name).toBe("acme-web-mail");
  });

  test.each([
    [`"Acme Web"`, `field "name" uses lowercase letters, digits and -, such as "acme-web-mail"`],
    [`"acme-"`, `field "name" uses lowercase letters, digits and -, such as "acme-web-mail"`],
    [`""`, `field "name" must be a non-empty string`],
  ])("refuses the name %s", (value, error) => {
    expect(
      errorsOf(tool(`name = ${value}\nissuer = { ${KIND}, permission = "full_access" }`)),
    ).toEqual([`${where()}${error}`]);
  });

  test("refuses a name without an issuer, which has nothing to name", () => {
    expect(errorsOf(tool(`name = "acme-web-mail"`))).toEqual([
      `${where()}field "name" names the key at its issuer; add an issuer, or remove the name`,
    ]);
  });

  test.each([
    [`admin = "op://Acme/a/credential"`, `missing field "kind"`],
    [`kind = "openai"`, `field "kind" must be one of: resend`],
    [`${KIND}, permission = "full_access", name = "x"`, `unknown field "name" for resend`],
    [
      `kind = "resend", admin = "Acme/a", permission = "full_access"`,
      `field "admin" must start with op:// or infisical://`,
    ],
    [
      `kind = "resend", admin = "op://Acme/resend key/credential", permission = "full_access"`,
      `field "admin" names the key's own item; the admin key needs its own item`,
    ],
    [
      `kind = "resend", admin = "infisical://p/prod/ADMIN", permission = "full_access"`,
      `field "admin" is in Infisical, and the key is in 1Password; keypin reads the admin key from the key's own vault account`,
    ],
    [
      `kind = "resend", admin = "op://<vault>/<item>/credential", permission = "full_access"`,
      `field "admin" has a <...> placeholder for its vault and item: replace it with the field's secret reference (in 1Password, open the field's menu and select Copy Secret Reference)`,
    ],
  ])("refuses %s", (fields, error) => {
    expect(errorsOf(issuer(fields))).toEqual([`${where()}issuer: ${error}`]);
  });

  test("refuses a name for an issuer that doesn't name its keys", () => {
    const text = tool(
      `name = "acme-web-db"\nissuer = { kind = "nameless", admin = "op://Acme/a/c" }`,
    );
    const nameless: IssuerKind = {
      kind: "nameless",
      names: false,
      parse: (read) => {
        const admin = read.admin();
        return admin ? { kind: "nameless", admin } : undefined;
      },
      connect: () => {
        throw new Error("never connected");
      },
    };
    const result = readSecretspec(text, MAP_FILE, KINDS, [...ISSUERS, nameless], VAULT_KINDS);
    assert(!result.ok);
    expect(result.errors).toEqual([
      `${where()}field "name": nameless doesn't name the keys it makes; remove the name`,
    ]);
  });

  test("two issuers that rotate the same thing are refused, naming both", () => {
    const text = `${PROFILES}\n[tool.keypin.production.API_KEY]\nissuer = { kind = "claims", admin = "op://Acme/admin/credential" }\n\n[tool.keypin.production.RESEND_API_KEY]\nissuer = { kind = "claims", admin = "op://Acme/admin/credential" }\n`;
    const claims: IssuerKind = {
      kind: "claims",
      parse: (read) => {
        const admin = read.admin();
        return admin ? { kind: "claims", admin } : undefined;
      },
      connect: () => {
        throw new Error("never connected");
      },
      claims: () => ["the account"],
    };
    const result = readSecretspec(text, MAP_FILE, KINDS, [...ISSUERS, claims], VAULT_KINDS);
    assert(!result.ok);
    expect(result.errors).toEqual([
      `${MAP_FILE}: [tool.keypin.production.RESEND_API_KEY] issuer: [tool.keypin.production.API_KEY] also rotates the account, so rotating either key breaks the other. Change one issuer so they share nothing, or remove one`,
    ]);
  });
});

describe("an issuer whose key's ID is another key", () => {
  const paired: IssuerKind<IssuerSpec & { kind: "paired"; keyId: string }> = {
    kind: "paired",
    parse: (read) => {
      read.only(["key_id"]);
      const admin = read.admin();
      const keyId = read.idKey();
      return admin && keyId ? { kind: "paired", admin, keyId } : undefined;
    },
    connect: () => {
      throw new Error("never connected");
    },
    idKey: (spec) => spec.keyId,
  };
  const map = (
    keyId: string,
    idItem = "key id",
    idTool = `publish = [${WORKER}]`,
    secretRef = `{ item = "secret", field = "credential" }`,
    idRef = `{ item = "${idItem}", field = "credential" }`,
  ) => `${HEAD}
[profiles.production]
SECRET = { description = "secret", ref = ${secretRef} }
KEY_ID = { description = "its ID", ref = ${idRef} }

[tool.keypin.production.SECRET]
publish = [${WORKER}]
issuer = { kind = "paired", admin = "op://Acme/admin/credential", key_id = "${keyId}" }

[tool.keypin.production.KEY_ID]
${idTool}
`;
  const parse = (text: string) =>
    readSecretspec(text, MAP_FILE, KINDS, [...ISSUERS, paired], VAULT_KINDS);
  const errors = (text: string) => {
    const result = parse(text);
    assert(!result.ok, "expected the file to be refused");
    return result.errors;
  };
  const at = `${MAP_FILE}: [tool.keypin.production.SECRET] issuer: `;

  test("names the ID key on the entry", () => {
    const result = parse(map("KEY_ID"));
    assert(result.ok, JSON.stringify(result));
    expect(result.map.keys[0]?.environments.production?.idKey).toBe("KEY_ID");
    expect(result.map.keys[1]?.environments.production).not.toHaveProperty("idKey");
  });

  test.each([
    [
      "the key itself",
      map("SECRET"),
      `field "key_id" names the key itself; name the key that holds its ID`,
    ],
    [
      "a key the profile doesn't declare",
      map("OTHER_ID"),
      `field "key_id" names "OTHER_ID", which isn't a secret of [profiles.production]; declare it there`,
    ],
    [
      "a key that reads the secret's field",
      map("KEY_ID", "secret"),
      `"KEY_ID" in [profiles.production] can read the same field as this key or its admin key; give the ID its own field`,
    ],
    ...["value", "password"].map((field) => [
      `a key that names "${field}" on an item the secret reads without naming a field`,
      map("KEY_ID", "", undefined, `{ item = "pair" }`, `{ item = "pair", field = "${field}" }`),
      `"KEY_ID" in [profiles.production] can read the same field as this key or its admin key; give the ID its own field`,
    ]),
    [
      "a key in a named section of an item the secret reads without naming a section or field",
      map(
        "KEY_ID",
        "",
        undefined,
        `{ item = "pair" }`,
        `{ item = "pair", section = "ids", field = "password" }`,
      ),
      `"KEY_ID" in [profiles.production] can read the same field as this key or its admin key; give the ID its own field`,
    ],
    [
      "a key in a named section that names the field the secret reads from the whole item",
      map(
        "KEY_ID",
        "",
        undefined,
        `{ item = "pair", field = "token" }`,
        `{ item = "pair", section = "ids", field = "token" }`,
      ),
      `"KEY_ID" in [profiles.production] can read the same field as this key or its admin key; give the ID its own field`,
    ],
    [
      "a key published elsewhere",
      map("KEY_ID", "key id", `publish = [${GITHUB}]`),
      `[tool.keypin.production.KEY_ID] publishes to different destinations; list the same destinations for both keys`,
    ],
  ])("refuses %s", (_, text, message) => {
    expect(errors(text)).toContain(`${at}${message}`);
  });

  test("accepts an ID in another field of the item the secret reads without naming a field", () => {
    const text = map(
      "KEY_ID",
      "",
      undefined,
      `{ item = "pair" }`,
      `{ item = "pair", field = "id" }`,
    );
    expect(parse(text).ok).toBe(true);
  });

  test("refuses a key_id that isn't a variable name", () => {
    expect(errors(map("not a name"))).toEqual([
      `${MAP_FILE}: [tool.keypin.production.SECRET]: issuer: field "key_id" must name a key in secretspec.toml, such as "API_KEY_ID"`,
    ]);
  });
});
