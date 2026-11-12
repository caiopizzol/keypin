import { assert, describe, expect, test } from "vite-plus/test";
import { formatReference, loadRegistry, parseMap } from "@keypin/core";
import { cli } from "../src/cli";
import { TEMPLATE } from "../src/commands/init";
import { fakeDeps, fakeVault, leaks, memoryFiles, REGISTRY, SENTINEL } from "./fakes";

const ROOT = "/work/billing";
const ENV = `${ROOT}/.env`;
const MAP = `${ROOT}/keypin.toml`;
const ACCOUNT = "my.1password.com";

const ENV_TEXT = [
  `STRIPE_KEY=${SENTINEL}-stripe`,
  `export WEBHOOK_SECRET="${SENTINEL}-webhook"`,
  "EMPTY=",
  `app.key=${SENTINEL}-dotted`,
  "",
].join("\n");

const REAL_MAP = `# my map, formatted my way
[1password]
account = "my.1password.com"

[keys.STRIPE_KEY]   # kept
rotate_every = "30d"
dev = "op://App Secrets/billing dev stripe/password"
`;

interface Setup {
  files?: Record<string, string>;
  items?: string[];
  failing?: string[];
  values?: Record<string, string>;
  terminal?: boolean;
  answer?: string;
}

function setup(options: Setup = {}) {
  const disk = memoryFiles({ [ENV]: ENV_TEXT, ...options.files });
  const fake = fakeVault({
    items: options.items ?? [],
    failing: options.failing,
    values: options.values,
  });
  const asked: string[] = [];
  const result = fakeDeps({
    disk,
    backend: fake.vault,
    deps: {
      isTerminal: options.terminal ?? false,
      ask: async (question) => {
        asked.push(question);
        return options.answer ?? "";
      },
    },
  });
  const text = () => result.stdout.text + result.stderr.text;
  return { ...result, fake, asked, text };
}

const NEW = ["import", ".env", "--vault", "App Secrets", "--account", ACCOUNT];

describe("keypin import", () => {
  test("with no keypin.toml, creates the items, writes a map that parses, and registers the project", async () => {
    const { deps, disk, fake, text } = setup();
    expect(await cli([...NEW, "--yes"], deps)).toBe(0);

    expect(fake.created.map((c) => [c.ref.item, c.ref.field, c.rotated])).toEqual([
      ["billing dev stripe key", "password", "2026-11-09"],
      ["billing dev webhook secret", "password", "2026-11-09"],
    ]);
    expect(fake.created.map((c) => c.ref.vault)).toEqual(["App Secrets", "App Secrets"]);
    expect(fake.created.map((c) => c.value.reveal())).toEqual([
      `${SENTINEL}-stripe`,
      `${SENTINEL}-webhook`,
    ]);

    const written = disk.contents.get(MAP);
    assert(written !== undefined);
    const parsed = parseMap(written, MAP);
    assert(parsed.ok, JSON.stringify(parsed));
    expect(parsed.map.account).toBe(ACCOUNT);
    expect(
      parsed.map.keys.map((k) => [
        k.name,
        k.rotateEvery,
        k.environments.dev ? formatReference(k.environments.dev.ref) : null,
      ]),
    ).toEqual([
      ["STRIPE_KEY", "90d", "op://App Secrets/billing dev stripe key/password"],
      ["WEBHOOK_SECRET", "90d", "op://App Secrets/billing dev webhook secret/password"],
    ]);
    expect((await loadRegistry(disk.files, REGISTRY)).projects).toEqual([ROOT]);
    expect(disk.contents.get(ENV)).toBe(ENV_TEXT);

    const out = text();
    expect(out).toContain("EMPTY: the value is empty");
    expect(out).toContain("app.key: not a variable name");
    expect(out).toContain(`keypin left ${ENV} as it is`);
    expect(out).toContain("app.key is still only in that file");
    expect(out).toContain("keypin run -- <command> provides them");
    expect(leaks(out, written, disk.contents.get(REGISTRY) ?? "")).toBe(false);
  });

  test("into the untouched init template, replaces it with a full map", async () => {
    const { deps, disk } = setup({ files: { [MAP]: TEMPLATE } });
    expect(await cli([...NEW, "--yes"], deps)).toBe(0);
    const written = disk.contents.get(MAP);
    assert(written !== undefined && written !== TEMPLATE);
    const parsed = parseMap(written, MAP);
    assert(parsed.ok);
    expect(parsed.map.keys.map((k) => k.name)).toEqual(["STRIPE_KEY", "WEBHOOK_SECRET"]);
    expect((await loadRegistry(disk.files, REGISTRY)).projects).toEqual([ROOT]);
  });

  test("into a real map, adds only new keys after the existing text, byte for byte", async () => {
    const { deps, disk, fake, text } = setup({
      files: { [MAP]: REAL_MAP },
      values: { "billing dev stripe": `${SENTINEL}-stripe` },
    });
    expect(await cli(["import", ".env", "--vault", "App Secrets", "--yes"], deps)).toBe(0);
    expect(fake.created.map((c) => c.ref.item)).toEqual(["billing dev webhook secret"]);
    const written = disk.contents.get(MAP);
    assert(written !== undefined);
    expect(written.startsWith(REAL_MAP)).toBe(true);
    expect(written.slice(REAL_MAP.length)).toBe(
      `\n[keys.WEBHOOK_SECRET]\nrotate_every = "90d"\ndev = "op://App Secrets/billing dev webhook secret/password"\n`,
    );
    const parsed = parseMap(written, MAP);
    assert(parsed.ok);
    expect(parsed.map.keys.find((k) => k.name === "STRIPE_KEY")?.rotateEvery).toBe("30d");
    expect(text()).toContain(
      `STRIPE_KEY: already mapped in ${MAP}; left as it is, and it matches the vault`,
    );
    expect(text()).toContain(
      `keypin: reading the mapped values, to compare with the file from 1Password account ${ACCOUNT}: op://App Secrets/billing dev stripe/password`,
    );
    expect(text()).toContain("app.key is still only in that file");
    expect(text()).not.toContain("STRIPE_KEY, app.key");
    expect(disk.contents.has(REGISTRY)).toBe(false);
  });

  test("a mapped variable whose vault value differs, or can't be read, is still only in the file", async () => {
    const env = `STRIPE_KEY=${SENTINEL}-stripe\nWEBHOOK_SECRET=${SENTINEL}-webhook\n`;
    const map = `${REAL_MAP}\n[keys.WEBHOOK_SECRET]\ndev = "op://App Secrets/billing dev webhook/password"\n`;
    const { deps, disk, fake, text } = setup({
      files: { [ENV]: env, [MAP]: map },
      values: { "billing dev stripe": `${SENTINEL}-rotated` },
      failing: ["billing dev webhook"],
    });
    expect(await cli(["import", ".env", "--vault", "App Secrets", "--yes"], deps)).toBe(0);
    expect(fake.created).toEqual([]);
    expect(fake.calls).toEqual(["read billing dev stripe", "read billing dev webhook"]);
    expect(disk.contents.get(MAP)).toBe(map);
    expect(text()).toContain(
      `STRIPE_KEY: already mapped in ${MAP}; left as it is, and it differs from the vault`,
    );
    expect(text()).toContain(
      `WEBHOOK_SECRET: already mapped in ${MAP}; left as it is, and op://App Secrets/billing dev webhook/password couldn't be read to compare`,
    );
    expect(text()).not.toContain("Delete it");
    expect(leaks(text(), disk.contents.get(MAP) ?? "")).toBe(false);
  });

  test("a mapped variable that differs keeps the file from being called safe to delete", async () => {
    const { deps, disk, text } = setup({
      files: { [MAP]: REAL_MAP },
      values: { "billing dev stripe": `${SENTINEL}-rotated` },
    });
    expect(await cli(["import", ".env", "--vault", "App Secrets", "--yes"], deps)).toBe(0);
    expect(text()).toContain("STRIPE_KEY, app.key are still only in that file");
    expect(text()).not.toContain("Delete it and stop loading it");
    expect(leaks(text(), disk.contents.get(MAP) ?? "", disk.contents.get(REGISTRY) ?? "")).toBe(
      false,
    );
  });

  test("uses the map's first environment, and refuses an --account the map doesn't use", async () => {
    const map = `environments = ["local", "prod"]\n\n[1password]\naccount = "${ACCOUNT}"\n`;
    const { deps, disk, fake } = setup({ files: { [MAP]: map } });
    expect(await cli(["import", ".env", "--vault", "V", "--yes"], deps)).toBe(0);
    expect(fake.created[0]?.ref.item).toBe("billing local stripe key");
    expect(disk.contents.get(MAP)).toContain(`local = "op://V/billing local stripe key/password"`);

    const other = setup({ files: { [MAP]: map } });
    const args = ["import", ".env", "--vault", "V", "--account", "other.1password.com"];
    expect(await cli(args, other.deps)).toBe(2);
    expect(other.stderr.text).toContain("uses 1Password account my.1password.com");
    expect(other.fake.calls).toEqual([]);
  });

  test("doesn't overwrite an item that exists: reports it, imports the rest, exits 1", async () => {
    const { deps, disk, fake, text } = setup({
      items: ["Billing Dev Stripe Key"],
      values: { "billing dev stripe key": "another value" },
    });
    expect(await cli([...NEW, "--yes"], deps)).toBe(1);
    expect(fake.created.map((c) => c.ref.item)).toEqual(["billing dev webhook secret"]);
    expect(text()).toContain(
      `STRIPE_KEY: "billing dev stripe key" already exists in vault App Secrets with another value; keypin doesn't overwrite it`,
    );
    const parsed = parseMap(disk.contents.get(MAP) ?? "", MAP);
    assert(parsed.ok);
    expect(parsed.map.keys.map((k) => k.name)).toEqual(["WEBHOOK_SECRET"]);
    expect(text()).toContain("app.key, STRIPE_KEY are still only in that file");
  });

  test("when every item exists, creates nothing, writes no map, exits 1", async () => {
    const { deps, disk, fake } = setup({
      items: ["billing dev stripe key", "billing dev webhook secret"],
    });
    expect(await cli([...NEW, "--yes"], deps)).toBe(1);
    expect(fake.created).toEqual([]);
    expect(disk.contents.has(MAP)).toBe(false);
    expect(disk.contents.has(REGISTRY)).toBe(false);
  });

  test("without a terminal, prints the plan and the rerun command, creates nothing, exits 3", async () => {
    const { deps, disk, fake, stderr } = setup();
    expect(await cli(NEW, deps)).toBe(3);
    expect(fake.created).toEqual([]);
    expect(fake.calls.filter((c) => c.startsWith("write"))).toEqual([]);
    expect(disk.contents.has(MAP)).toBe(false);
    expect(disk.contents.has(REGISTRY)).toBe(false);
    expect(stderr.text).toContain(
      `Import ${ENV} into 1Password account ${ACCOUNT}, vault App Secrets:`,
    );
    expect(stderr.text).toContain(
      `create "billing dev stripe key" (password, rotated 2026-11-09), and map STRIPE_KEY to op://App Secrets/billing dev stripe key/password`,
    );
    expect(stderr.text).toContain(`Map: write ${MAP} and register ${ROOT}`);
    expect(stderr.text).toContain(
      `cd /work/billing && /opt/bun/bin/bun --no-env-file /home/me/keypin/apps/cli/src/main.ts import .env --vault 'App Secrets' --account ${ACCOUNT}`,
    );
    expect(leaks(stderr.text)).toBe(false);
  });

  test("in a terminal, creates only after a typed yes", async () => {
    const no = setup({ terminal: true, answer: "y" });
    expect(await cli(NEW, no.deps)).toBe(3);
    expect(no.asked).toEqual(["Type yes to create 2 items in 1Password: "]);
    expect(no.fake.created).toEqual([]);
    expect(no.disk.contents.has(MAP)).toBe(false);

    const yes = setup({ terminal: true, answer: "yes" });
    expect(await cli(NEW, yes.deps)).toBe(0);
    expect(yes.fake.created).toHaveLength(2);
  });

  test("a failure midway stops, and maps only the items it created; a rerun finishes", async () => {
    const env = `A_KEY=${SENTINEL}-a\nB_KEY=${SENTINEL}-b\nC_KEY=${SENTINEL}-c\n`;
    const { deps, disk, fake, text } = setup({
      files: { [ENV]: env },
      failing: ["billing dev b key"],
    });
    expect(await cli([...NEW, "--yes"], deps)).toBe(1);
    expect(fake.created.map((c) => c.ref.item)).toEqual(["billing dev a key"]);
    expect(fake.calls).not.toContain("write billing dev c key");
    expect(text()).toContain("Stopped. Created A_KEY; not created: B_KEY, C_KEY.");
    const first = disk.contents.get(MAP);
    assert(first !== undefined);
    const parsed = parseMap(first, MAP);
    assert(parsed.ok);
    expect(parsed.map.keys.map((k) => k.name)).toEqual(["A_KEY"]);
    expect(leaks(text(), first)).toBe(false);

    const again = fakeDeps({ disk, backend: fakeVault({ items: ["billing dev a key"] }).vault });
    expect(await cli(["import", ".env", "--vault", "App Secrets", "--yes"], again.deps)).toBe(0);
    const second = parseMap(disk.contents.get(MAP) ?? "", MAP);
    assert(second.ok);
    expect(second.map.keys.map((k) => k.name)).toEqual(["A_KEY", "B_KEY", "C_KEY"]);
    expect(disk.contents.get(MAP)?.startsWith(first)).toBe(true);
  });

  test("an item stored before the map was written is mapped on the rerun, not created again", async () => {
    const { deps, disk, fake, text } = setup({ files: { [MAP]: REAL_MAP } });
    const write = fake.vault.write.bind(fake.vault);
    fake.vault.write = async (ref, secret, options) => {
      await write(ref, secret, options);
      throw new Error("1Password: the connection closed");
    };
    expect(await cli(["import", ".env", "--vault", "App Secrets", "--yes"], deps)).toBe(1);
    expect(fake.created.map((c) => c.ref.item)).toEqual(["billing dev webhook secret"]);
    expect(disk.contents.get(MAP)).toBe(REAL_MAP);

    fake.vault.write = write;
    const again = fakeDeps({ disk, backend: fake.vault, deps: { isTerminal: false } });
    expect(await cli(["import", ".env", "--vault", "App Secrets"], again.deps)).toBe(0);
    expect(fake.created).toHaveLength(1);
    expect(fake.calls.filter((c) => c.startsWith("write"))).toHaveLength(1);
    const parsed = parseMap(disk.contents.get(MAP) ?? "", MAP);
    assert(parsed.ok);
    expect(parsed.map.keys.map((k) => k.name)).toEqual(["STRIPE_KEY", "WEBHOOK_SECRET"]);
    const out = again.stdout.text + again.stderr.text;
    expect(out).toContain(
      "map WEBHOOK_SECRET to op://App Secrets/billing dev webhook secret/password, an item that exists with the same value",
    );
    expect(leaks(text(), out, disk.contents.get(MAP) ?? "")).toBe(false);
  });

  test("an existing item with another value, or one it can't read, is skipped and not read out", async () => {
    const env = `A_KEY=${SENTINEL}-a\nB_KEY=${SENTINEL}-b\n`;
    const disk = memoryFiles({ [ENV]: env });
    const fake = fakeVault({
      items: ["billing dev a key", "billing dev b key"],
      values: { "billing dev a key": `${SENTINEL}-other` },
      failing: ["billing dev b key"],
    });
    const { deps, stdout, stderr } = fakeDeps({ disk, backend: fake.vault });
    expect(await cli([...NEW, "--yes"], deps)).toBe(1);
    expect(fake.created).toEqual([]);
    expect(disk.contents.has(MAP)).toBe(false);
    const out = stdout.text + stderr.text;
    expect(out).toContain(
      `A_KEY: "billing dev a key" already exists in vault App Secrets with another value; keypin doesn't overwrite it`,
    );
    expect(out).toContain(
      `B_KEY: "billing dev b key" already exists in vault App Secrets and couldn't be read`,
    );
    expect(leaks(out)).toBe(false);
  });

  test("refuses a keypin.toml that is a symbolic link before touching the vault", async () => {
    for (const found of [undefined, TEMPLATE, REAL_MAP]) {
      const { deps, disk, fake, stderr } = setup({ files: found ? { [MAP]: found } : {} });
      disk.links.add(MAP);
      const args = found === REAL_MAP ? ["--yes"] : ["--account", ACCOUNT, "--yes"];
      expect(await cli(["import", ".env", "--vault", "V", ...args], deps)).toBe(1);
      expect(stderr.text).toContain(`${MAP} is a symbolic link`);
      expect(fake.calls).toEqual([]);
      expect(disk.contents.get(MAP)).toBe(found);
      expect(disk.contents.has(REGISTRY)).toBe(false);
    }
  });

  test("if the map changed while it ran, writes nothing over it and prints the tables to add", async () => {
    const { deps, disk, fake, stdout, stderr } = setup({ files: { [MAP]: REAL_MAP } });
    const write = fake.vault.write.bind(fake.vault);
    fake.vault.write = async (ref, secret, options) => {
      await write(ref, secret, options);
      disk.contents.set(MAP, `${REAL_MAP}# edited\n`);
    };
    expect(await cli(["import", ".env", "--vault", "V", "--yes"], deps)).toBe(1);
    expect(disk.contents.get(MAP)).toBe(`${REAL_MAP}# edited\n`);
    expect(stderr.text).toContain("changed while import ran");
    expect(stderr.text).toContain(`Add this at the end of ${MAP} by hand:`);
    expect(stdout.text).toContain("[keys.WEBHOOK_SECRET]");
    expect(stdout.text).not.toContain("[1password]");
    const pasted = parseMap(`${REAL_MAP}# edited\n${stdout.text}`, MAP);
    assert(pasted.ok, JSON.stringify(pasted));
    expect(leaks(stdout.text, stderr.text)).toBe(false);
  });

  test("with no map, if one appears while it runs, prints a whole map with the account to save", async () => {
    const { deps, disk, fake, stdout, stderr } = setup();
    const write = fake.vault.write.bind(fake.vault);
    fake.vault.write = async (ref, secret, options) => {
      await write(ref, secret, options);
      disk.contents.set(MAP, "# someone else's\n");
    };
    expect(await cli([...NEW, "--yes"], deps)).toBe(1);
    expect(disk.contents.get(MAP)).toBe("# someone else's\n");
    expect(stderr.text).toContain(`Save this as ${MAP} by hand:`);
    const pasted = parseMap(stdout.text, MAP);
    assert(pasted.ok, JSON.stringify(pasted));
    expect(pasted.map.account).toBe(ACCOUNT);
    expect(pasted.map.keys.map((k) => k.name)).toEqual(["STRIPE_KEY", "WEBHOOK_SECRET"]);
    expect(leaks(stdout.text, stderr.text)).toBe(false);
  });

  test("a key mapped only in another environment stays in the file, and the file isn't called done", async () => {
    const map = `${REAL_MAP.replace('dev = "op://App Secrets/billing dev stripe/password"', '[keys.STRIPE_KEY.prod]\nfrom = "op://App Secrets/billing prod stripe/password"')}`;
    const { deps, disk, fake, text } = setup({ files: { [MAP]: map } });
    expect(await cli(["import", ".env", "--vault", "App Secrets", "--yes"], deps)).toBe(0);
    expect(fake.created.map((c) => c.ref.item)).toEqual(["billing dev webhook secret"]);
    expect(disk.contents.get(MAP)?.startsWith(map)).toBe(true);
    expect(text()).toContain(
      `STRIPE_KEY: mapped in ${MAP} without dev; left as it is, so add its dev reference by hand`,
    );
    expect(text()).toContain("STRIPE_KEY, app.key are still only in that file");
    expect(text()).not.toContain("Delete it and stop loading it");
    expect(leaks(text(), disk.contents.get(MAP) ?? "")).toBe(false);
  });

  test("a value with a $ is left in the file, since loaders differ on expanding it", async () => {
    const env = `BASE=${SENTINEL}\nTOKEN=hello$BASE\nESCAPED="hello\\$BASE"\n`;
    const { deps, fake, text } = setup({ files: { [ENV]: env } });
    expect(await cli([...NEW, "--yes"], deps)).toBe(0);
    expect(fake.created.map((c) => c.ref.item)).toEqual(["billing dev base"]);
    expect(text()).toContain("TOKEN: the value has a $");
    expect(text()).toContain("ESCAPED: the value has a $");
    expect(text()).toContain("TOKEN, ESCAPED are still only in that file");
    expect(leaks(text())).toBe(false);
  });

  test("a map an appended table would break stops before the vault, and changes nothing", async () => {
    const inline = `keys = { STRIPE_KEY = { dev = "op://V/s/password" } }\n\n[1password]\naccount = "${ACCOUNT}"\n`;
    const { deps, disk, fake, stderr } = setup({ files: { [MAP]: inline } });
    expect(await cli(["import", ".env", "--vault", "V", "--yes"], deps)).toBe(1);
    expect(stderr.text).toContain("wouldn't parse, so nothing was created");
    expect(fake.calls).toEqual([]);
    expect(disk.contents.get(MAP)).toBe(inline);
  });

  test("two variables that would share an item: imports the first, keeps the second in the file", async () => {
    const env = `API_KEY=${SENTINEL}-1\napi_key=${SENTINEL}-2\n`;
    const { deps, fake, text } = setup({ files: { [ENV]: env } });
    expect(await cli([...NEW, "--yes"], deps)).toBe(0);
    expect(fake.created.map((c) => c.ref.item)).toEqual(["billing dev api key"]);
    expect(text()).toContain(
      `api_key: its item would be "billing dev api key", the same as API_KEY's`,
    );
    expect(text()).toContain("api_key is still only in that file");
    expect(leaks(text())).toBe(false);
  });

  test("a map that doesn't parse stops before the vault", async () => {
    const { deps, fake, stderr } = setup({ files: { [MAP]: "[keys.X]\nbad = 1\n" } });
    expect(await cli(["import", ".env", "--vault", "V", "--yes"], deps)).toBe(1);
    expect(stderr.text).toContain(`fix ${MAP} first`);
    expect(fake.calls).toEqual([]);
  });

  test("usage errors: no --vault, no --account without a map, no file, an example file", async () => {
    const cases: [string[], string][] = [
      [["import", ".env", "--account", ACCOUNT], "--vault is required"],
      [["import", ".env", "--vault", "V"], "--account is required"],
      [["import", "--vault", "V", "--account", ACCOUNT], "takes one env file"],
      [["import", ".env.example", "--vault", "V", "--account", ACCOUNT], "is an example file"],
    ];
    for (const [args, message] of cases) {
      const { deps, fake, stderr } = setup({ files: { [MAP]: TEMPLATE } });
      expect(await cli(args, deps)).toBe(2);
      expect(stderr.text).toContain(message);
      expect(fake.calls).toEqual([]);
    }
  });

  test("a missing file fails without touching the vault", async () => {
    const { deps, fake, stderr } = setup();
    const args = ["import", ".dev.vars", "--vault", "V", "--account", ACCOUNT, "--yes"];
    expect(await cli(args, deps)).toBe(1);
    expect(stderr.text).toContain(`${ROOT}/.dev.vars doesn't exist`);
    expect(fake.calls).toEqual([]);
  });
});
