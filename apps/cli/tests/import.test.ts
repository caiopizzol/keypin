import { assert, describe, expect, test, vi } from "vite-plus/test";
import { formatReference, loadRegistry, readSecretspec } from "@keypin/core";
import { onePasswordBackend } from "@keypin/connectors/onepassword";
import { fakeOnePassword } from "@keypin/connectors/onepassword/testing";
import { cli } from "../src/cli";
import { destinations, issuers, vaults } from "../src/start";
import { template } from "../src/commands/init";
import {
  ESC,
  fakeDeps,
  fakeVault,
  leaks,
  memoryFiles,
  REGISTRY,
  SENTINEL,
  unstyled,
} from "./fakes";
import { changes, recording } from "./recording";

const TEMPLATE = template("billing");

const ROOT = "/work/billing";
const ENV = `${ROOT}/.env`;
const MAP = `${ROOT}/secretspec.toml`;
const ACCOUNT = "my.1password.com";

const ENV_TEXT = [
  `STRIPE_KEY=${SENTINEL}-stripe`,
  `export WEBHOOK_SECRET="${SENTINEL}-webhook"`,
  "EMPTY=",
  `app.key=${SENTINEL}-dotted`,
  "",
].join("\n");

const REAL_MAP = `[project]
name = "billing"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@App Secrets"

[defaults]
providers = ["vault"]

[profiles.dev]
STRIPE_KEY = { description = "STRIPE_KEY", ref = { item = "billing dev stripe", field = "password" } }

[profiles.prod]

[tool.keypin.dev.STRIPE_KEY]
rotate_every = "30d"
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
  const record = async (name: string, args: string[]) => {
    const before = new Map(disk.contents);
    const exit = await cli(args, result.deps);
    await expect(
      recording({
        args,
        exit,
        stdout: result.stdout.text,
        stderr: result.stderr.text,
        files: Object.fromEntries(before),
        given: { "vault items": options.items ?? [] },
        calls: { vault: fake.calls, asked },
        wrote: changes(before, disk.contents),
      }),
    ).toMatchFileSnapshot(`./recordings/import/${name}.txt`);
    return exit;
  };
  return { ...result, fake, asked, text, record };
}

const squash = (text: string) => text.replace(/ {2,}/g, "  ");

const NEW = ["import", ".env", "--vault", "App Secrets", "--account", ACCOUNT];

describe("keypin import", () => {
  test("with no secretspec.toml, creates the items, writes a map that parses, and registers the project", async () => {
    const { disk, fake, text, record } = setup();
    expect(await record("new-map", [...NEW, "--yes"])).toBe(0);
    expect(fake.created.map((c) => [c.ref.vault, c.ref.item, c.ref.field, c.rotated])).toEqual([
      ["App Secrets", "billing default stripe key", "password", "2026-11-09"],
      ["App Secrets", "billing default webhook secret", "password", "2026-11-09"],
    ]);
    expect(fake.created.map((c) => c.value.reveal())).toEqual([
      `${SENTINEL}-stripe`,
      `${SENTINEL}-webhook`,
    ]);
    const written = disk.contents.get(MAP);
    assert(written !== undefined);
    const parsed = readSecretspec(written, MAP, destinations, issuers, vaults);
    assert(parsed.ok, JSON.stringify(parsed));
    expect(parsed.map.keys.map((k) => k.name)).toEqual(["STRIPE_KEY", "WEBHOOK_SECRET"]);
    expect(disk.contents.get(ENV)).toBe(ENV_TEXT);
    expect(leaks(text(), written, disk.contents.get(REGISTRY) ?? "")).toBe(false);
  });

  test("prints the plan as aligned rows: + create, = map an existing item, - skipped", async () => {
    const env = `STRIPE_KEY=${SENTINEL}-stripe\nWEBHOOK_SECRET=${SENTINEL}-webhook\nEMPTY=\n`;
    const { record } = setup({
      files: { [ENV]: env },
      items: ["billing default webhook secret"],
      values: { "billing default webhook secret": `${SENTINEL}-webhook` },
    });
    expect(await record("existing-item", [...NEW, "--yes"])).toBe(0);
  });

  test("in a terminal, vault work runs as live steps, skipped rows are dim, and the guidance is plain", async () => {
    const { deps, stderr } = setup();
    deps.styled = { stdout: true, stderr: true };
    expect(await cli([...NEW, "--yes"], deps)).toBe(0);
    const plain = unstyled(stderr.text);
    expect(plain).toContain(
      `\r${ESC}[2K✓ Listed the items in vault App Secrets of 1Password account my.1password.com, not the values`,
    );
    expect(plain).toContain(
      `\r${ESC}[2K✓ Created "billing default stripe key" in vault App Secrets`,
    );
    expect(stderr.text).toContain(
      `${ESC}[2m- EMPTY           skipped: the value is empty${ESC}[0m`,
    );
    expect(stderr.text).toContain(
      "\nRemove the STRIPE_KEY, WEBHOOK_SECRET lines from it: keypin run warns while an env file holds a key it provides.\n",
    );
    expect(
      stderr.text.endsWith("keypin run warns while an env file holds a key it provides.\n"),
    ).toBe(true);
  });

  test("at 80 columns, every slow vault step keeps the 1Password approval hint in view", async () => {
    vi.useFakeTimers();
    try {
      const env = `STRIPE_KEY=${SENTINEL}-stripe\nWEBHOOK_SECRET=${SENTINEL}-webhook\nOLD_KEY=${SENTINEL}-old\n`;
      const map = `[project]\nname = "billing"\nrevision = "1.0"\n\n[providers]\nvault = "onepassword://${ACCOUNT}@App Secrets"\n\n[defaults]\nproviders = ["vault"]\n\n[profiles.dev]\nOLD_KEY = { description = "OLD_KEY", ref = { item = "billing dev old", field = "password" } }\n`;
      const { deps, fake, stderr } = setup({
        files: { [ENV]: env, [MAP]: map },
        items: ["billing dev webhook secret"],
        values: {
          "billing dev webhook secret": `${SENTINEL}-webhook`,
          "billing dev old": `${SENTINEL}-old`,
        },
      });
      const slow =
        <A extends unknown[], R>(work: (...args: A) => Promise<R>) =>
        async (...args: A) => {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          return work(...args);
        };
      fake.vault.list = slow(fake.vault.list.bind(fake.vault));
      fake.vault.read = slow(fake.vault.read.bind(fake.vault));
      fake.vault.write = slow(fake.vault.write.bind(fake.vault));
      deps.styled = { stdout: true, stderr: true };
      deps.columns = () => 80;
      let code: number | undefined;
      void cli(["import", ".env", "--vault", "App Secrets", "--yes"], deps).then((c) => (code = c));
      while (code === undefined) await vi.advanceTimersByTimeAsync(100);
      expect(code).toBe(0);
      const frames = stderr.text
        .split(`\r${ESC}[2K`)
        .map((frame) => unstyled(frame))
        .filter((frame) => frame && !frame.includes("\n"));
      const running = [...new Set(frames.map((frame) => frame.slice(2).split("  ")[0]))];
      expect(running).toEqual([
        "Listing vault App Secrets",
        "Reading 1 existing item",
        "Reading 1 mapped value",
        "Creating item 1 of 1",
      ]);
      for (const label of running)
        expect(
          frames.some((f) =>
            f.endsWith(` ${label}  1Password may be asking you to approve keypin`),
          ),
          label,
        ).toBe(true);
      for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(79);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a create that fails ends as a failed line with the reason under it", async () => {
    const env = `A_KEY=${SENTINEL}-a\nB_KEY=${SENTINEL}-b\n`;
    const { deps, stderr } = setup({ files: { [ENV]: env }, failing: ["billing default b key"] });
    expect(await cli([...NEW, "--yes"], deps)).toBe(1);
    expect(stderr.text).toContain(
      `ok     Created "billing default a key" in vault App Secrets\nFAILED Couldn't create "billing default b key" in vault App Secrets\n    1Password: "billing default b key" isn't readable\n`,
    );
    expect(leaks(stderr.text)).toBe(false);
  });

  test("into the untouched init template, replaces it with a full map", async () => {
    const { deps, disk } = setup({ files: { [MAP]: TEMPLATE } });
    expect(await cli([...NEW, "--yes"], deps)).toBe(0);
    const written = disk.contents.get(MAP);
    assert(written !== undefined && written !== TEMPLATE);
    const parsed = readSecretspec(written, MAP, destinations, issuers, vaults);
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
    expect(written.slice(REAL_MAP.length)).toMatch(/^\n\[profiles\.dev\.WEBHOOK_SECRET\]\n/);
    const parsed = readSecretspec(written, MAP, destinations, issuers, vaults);
    assert(parsed.ok);
    const webhook = parsed.map.keys.find((k) => k.name === "WEBHOOK_SECRET");
    expect(webhook?.environments.dev?.ref).toMatchObject({
      vault: "App Secrets",
      item: "billing dev webhook secret",
      field: "password",
    });
    expect(webhook?.rotateEvery?.text).toBe("90d");
    expect(parsed.map.keys.find((k) => k.name === "STRIPE_KEY")?.rotateEvery?.text).toBe("30d");
    expect(squash(text())).toContain(
      `- STRIPE_KEY  skipped: already mapped in ${MAP}; left as it is, and it matches the vault`,
    );
    expect(text()).toContain(
      `ok     Read 1 mapped value from 1Password account ${ACCOUNT}, to compare with the file  op://App Secrets/billing dev stripe/password`,
    );
    expect(text()).toContain("app.key is still only in that file");
    expect(text()).not.toContain("STRIPE_KEY, app.key");
    expect(disk.contents.has(REGISTRY)).toBe(false);
  });

  test("a mapped variable whose vault value differs, or can't be read, is still only in the file", async () => {
    const env = `STRIPE_KEY=${SENTINEL}-stripe\nWEBHOOK_SECRET=${SENTINEL}-webhook\n`;
    const map = `${REAL_MAP}\n\n[profiles.dev.WEBHOOK_SECRET]\ndescription = "WEBHOOK_SECRET"\nref = { item = "billing dev webhook", field = "password" }\n`;
    const { deps, disk, fake, text } = setup({
      files: { [ENV]: env, [MAP]: map },
      values: { "billing dev stripe": `${SENTINEL}-rotated` },
      failing: ["billing dev webhook"],
    });
    expect(await cli(["import", ".env", "--vault", "App Secrets", "--yes"], deps)).toBe(0);
    expect(fake.created).toEqual([]);
    expect(fake.calls).toEqual(["read billing dev stripe", "read billing dev webhook"]);
    expect(disk.contents.get(MAP)).toBe(map);
    expect(squash(text())).toContain(
      `- STRIPE_KEY  skipped: already mapped in ${MAP}; left as it is, and it differs from the vault`,
    );
    expect(squash(text())).toContain(
      `- WEBHOOK_SECRET  skipped: already mapped in ${MAP}; left as it is, and op://App Secrets/billing dev webhook/password couldn't be read to compare`,
    );
    expect(text()).not.toContain("Delete it");
    expect(leaks(text(), disk.contents.get(MAP) ?? "")).toBe(false);
  });

  test("a mapped value with a $ is still only in the file, even when the vault holds the same text", async () => {
    const dollar = `${SENTINEL}-$OTHER`;
    const { deps, fake, text } = setup({
      files: {
        [ENV]: `STRIPE_KEY=${dollar}\nWEBHOOK_SECRET=${SENTINEL}-webhook\n`,
        [MAP]: REAL_MAP,
      },
      values: { "billing dev stripe": dollar },
    });
    expect(await cli(["import", ".env", "--vault", "App Secrets", "--yes"], deps)).toBe(0);
    expect(fake.calls).not.toContain("read billing dev stripe");
    expect(fake.created.map((c) => c.ref.item)).toEqual(["billing dev webhook secret"]);
    expect(squash(text())).toContain(
      `- STRIPE_KEY  skipped: already mapped in ${MAP}; left as it is, but the value has a $, which some loaders expand to another variable's value, so keypin can't compare it with the vault`,
    );
    expect(text()).toContain("STRIPE_KEY is still only in that file");
    expect(text()).not.toContain("Delete it and stop loading it");
    expect(leaks(text())).toBe(false);
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
    const map = `[project]\nname = "billing"\nrevision = "1.0"\n\n[defaults]\nproviders = ["onepassword://${ACCOUNT}@V"]\n\n[profiles.local]\n\n[profiles.prod]\n`;
    const { deps, disk, fake } = setup({ files: { [MAP]: map } });
    expect(await cli(["import", ".env", "--vault", "V", "--yes"], deps)).toBe(0);
    expect(fake.created[0]?.ref.item).toBe("billing local stripe key");
    expect(disk.contents.get(MAP)).toContain(
      `[profiles.local.STRIPE_KEY]\ndescription = "STRIPE_KEY"\nref = { item = "billing local stripe key", field = "password" }`,
    );

    const other = setup({ files: { [MAP]: map } });
    const args = ["import", ".env", "--vault", "V", "--account", "other.1password.com"];
    expect(await cli(args, other.deps)).toBe(2);
    expect(other.stderr.text).toContain("uses 1Password account my.1password.com");
    expect(other.fake.calls).toEqual([]);
  });

  test("doesn't overwrite an item that exists: reports it, imports the rest, exits 1", async () => {
    const { deps, disk, fake, text } = setup({
      items: ["Billing Default Stripe Key"],
      values: { "billing default stripe key": "another value" },
    });
    expect(await cli([...NEW, "--yes"], deps)).toBe(1);
    expect(fake.created.map((c) => c.ref.item)).toEqual(["billing default webhook secret"]);
    expect(squash(text())).toContain(
      `- STRIPE_KEY  skipped: "billing default stripe key" already exists in vault App Secrets with another value; keypin doesn't overwrite it`,
    );
    const parsed = readSecretspec(disk.contents.get(MAP) ?? "", MAP, destinations, issuers, vaults);
    assert(parsed.ok);
    expect(parsed.map.keys.map((k) => k.name)).toEqual(["WEBHOOK_SECRET"]);
    expect(text()).toContain("app.key, STRIPE_KEY are still only in that file");
  });

  test("when every item exists, creates nothing, writes no map, exits 1", async () => {
    const { deps, disk, fake } = setup({
      items: ["billing default stripe key", "billing default webhook secret"],
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
      `\nImport ${ENV}  into 1Password account ${ACCOUNT}, vault App Secrets\n`,
    );
    expect(squash(stderr.text)).toContain(
      `+ STRIPE_KEY  op://App Secrets/billing default stripe key/password  create, rotated 2026-11-09\n`,
    );
    expect(stderr.text).toContain(`Map: write ${MAP} and register ${ROOT}`);
    expect(stderr.text).toContain(
      `cd /work/billing && /opt/bun/bin/bun --no-env-file /home/me/keypin/apps/cli/src/main.ts import .env --vault 'App Secrets' --account ${ACCOUNT}`,
    );
    expect(leaks(stderr.text)).toBe(false);
  });

  test("when the keypin on PATH is this keypin, the rerun command is keypin import", async () => {
    const { deps, stderr } = setup();
    expect(await cli(NEW, { ...deps, self: { folder: "/tmp/billing", command: ["keypin"] } })).toBe(
      3,
    );
    expect(stderr.text).toContain(
      `cd /tmp/billing && keypin import .env --vault 'App Secrets' --account ${ACCOUNT}\n`,
    );
  });

  test("in a terminal, creates only after y or yes", async () => {
    const no = setup({ terminal: true, answer: "n" });
    expect(await cli(NEW, no.deps)).toBe(3);
    expect(no.asked).toEqual(["Create 2 items in 1Password? [y/N] "]);
    expect(no.fake.created).toEqual([]);
    expect(no.disk.contents.has(MAP)).toBe(false);

    for (const answer of ["y", "yes"]) {
      const yes = setup({ terminal: true, answer });
      expect(await cli(NEW, yes.deps)).toBe(0);
      expect(yes.fake.created).toHaveLength(2);
    }
  });

  test("an item created in 1Password while the prompt is open is refused, and isn't mapped", async () => {
    const onePassword = fakeOnePassword([], ["App Secrets"]);
    const vault = onePasswordBackend(async () => onePassword.client);
    const title = "billing default stripe key";
    const disk = memoryFiles({ [ENV]: `STRIPE_KEY=${SENTINEL}\n` });
    const run = fakeDeps({
      disk,
      backend: vault,
      deps: {
        isTerminal: true,
        ask: async () => {
          await onePassword.client.items.create({
            category: "Password",
            vaultId: "vault-1",
            title,
          });
          return "y";
        },
      },
    });
    expect(await cli(NEW, run.deps)).toBe(1);
    expect(onePassword.calls.create.map((created) => created.title)).toEqual([title]);
    expect(run.stdout.text + run.stderr.text).toContain(
      "the item already exists; keypin doesn't overwrite it",
    );
    expect(disk.contents.has(MAP)).toBe(false);
  });

  test("a failure midway stops, and maps only the items it created; a rerun finishes", async () => {
    const env = `A_KEY=${SENTINEL}-a\nB_KEY=${SENTINEL}-b\nC_KEY=${SENTINEL}-c\n`;
    const { deps, disk, fake, text } = setup({
      files: { [ENV]: env },
      failing: ["billing default b key"],
    });
    expect(await cli([...NEW, "--yes"], deps)).toBe(1);
    expect(fake.created.map((c) => c.ref.item)).toEqual(["billing default a key"]);
    expect(fake.calls).not.toContain("write billing default c key");
    expect(text()).toContain("Stopped. Created A_KEY; not created: B_KEY, C_KEY.");
    const first = disk.contents.get(MAP);
    assert(first !== undefined);
    const parsed = readSecretspec(first, MAP, destinations, issuers, vaults);
    assert(parsed.ok);
    expect(parsed.map.keys.map((k) => k.name)).toEqual(["A_KEY"]);
    expect(leaks(text(), first)).toBe(false);

    const again = fakeDeps({
      disk,
      backend: fakeVault({ items: ["billing default a key"] }).vault,
    });
    expect(await cli(["import", ".env", "--vault", "App Secrets", "--yes"], again.deps)).toBe(0);
    const second = readSecretspec(disk.contents.get(MAP) ?? "", MAP, destinations, issuers, vaults);
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
    const parsed = readSecretspec(disk.contents.get(MAP) ?? "", MAP, destinations, issuers, vaults);
    assert(parsed.ok);
    expect(parsed.map.keys.map((k) => k.name)).toEqual(["STRIPE_KEY", "WEBHOOK_SECRET"]);
    const out = again.stdout.text + again.stderr.text;
    expect(squash(out)).toContain(
      "= WEBHOOK_SECRET  op://App Secrets/billing dev webhook secret/password  exists with the same value; map it\n",
    );
    expect(leaks(text(), out, disk.contents.get(MAP) ?? "")).toBe(false);
  });

  test("an existing item with another value, or one it can't read, is skipped and not read out", async () => {
    const env = `A_KEY=${SENTINEL}-a\nB_KEY=${SENTINEL}-b\n`;
    const disk = memoryFiles({ [ENV]: env });
    const fake = fakeVault({
      items: ["billing default a key", "billing default b key"],
      values: { "billing default a key": `${SENTINEL}-other` },
      failing: ["billing default b key"],
    });
    const { deps, stdout, stderr } = fakeDeps({ disk, backend: fake.vault });
    expect(await cli([...NEW, "--yes"], deps)).toBe(1);
    expect(fake.created).toEqual([]);
    expect(disk.contents.has(MAP)).toBe(false);
    const out = stdout.text + stderr.text;
    expect(squash(out)).toContain(
      `- A_KEY  skipped: "billing default a key" already exists in vault App Secrets with another value; keypin doesn't overwrite it`,
    );
    expect(squash(out)).toContain(
      `- B_KEY  skipped: "billing default b key" already exists in vault App Secrets and couldn't be read`,
    );
    expect(leaks(out)).toBe(false);
  });

  test("refuses a secretspec.toml that is a symbolic link before touching the vault", async () => {
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
    expect(stdout.text).toContain("[profiles.dev.WEBHOOK_SECRET]");
    expect(stdout.text).not.toContain("[project]");
    const pasted = readSecretspec(
      `${REAL_MAP}# edited\n${stdout.text}`,
      MAP,
      destinations,
      issuers,
      vaults,
    );
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
    const pasted = readSecretspec(stdout.text, MAP, destinations, issuers, vaults);
    assert(pasted.ok, JSON.stringify(pasted));
    expect(pasted.map.keys[0]?.environments.default?.ref.account).toBe(ACCOUNT);
    expect(pasted.map.keys.map((k) => k.name)).toEqual(["STRIPE_KEY", "WEBHOOK_SECRET"]);
    expect(leaks(stdout.text, stderr.text)).toBe(false);
  });

  test("a key mapped only in another environment gets this one added, and the rest is kept", async () => {
    const map = REAL_MAP.replace(
      'STRIPE_KEY = { description = "STRIPE_KEY", ref = { item = "billing dev stripe", field = "password" } }\n\n[profiles.prod]\n',
      '\n[profiles.prod]\nSTRIPE_KEY = { description = "STRIPE_KEY", ref = { item = "billing prod stripe", field = "password" } }\n',
    ).replace("[tool.keypin.dev.STRIPE_KEY]", "[tool.keypin.prod.STRIPE_KEY]");
    const { deps, disk, fake, text } = setup({ files: { [MAP]: map } });
    expect(await cli(["import", ".env", "--vault", "App Secrets", "--yes"], deps)).toBe(0);
    expect(fake.created.map((c) => c.ref.item)).toEqual([
      "billing dev stripe key",
      "billing dev webhook secret",
    ]);
    const written = disk.contents.get(MAP) ?? "";
    expect(written.startsWith(map)).toBe(true);
    expect(written.slice(map.length)).toContain(
      `\n[profiles.dev.STRIPE_KEY]\ndescription = "STRIPE_KEY"\nref = { item = "billing dev stripe key", field = "password" }\n`,
    );
    const parsed = readSecretspec(written, MAP, destinations, issuers, vaults);
    assert(parsed.ok, JSON.stringify(parsed));
    const stripe = parsed.map.keys.find((k) => k.name === "STRIPE_KEY");
    expect(stripe?.rotateEvery?.text).toBe("30d");
    expect(Object.keys(stripe?.environments ?? {}).sort()).toEqual(["dev", "prod"]);
    expect(text()).toContain("Map: add 1 key, and dev for STRIPE_KEY at the end of");
    expect(text()).not.toContain("by hand");
    expect(leaks(text(), written)).toBe(false);
  });

  describe("--profile", () => {
    const PROD_ENV = `${ROOT}/.env.production`;
    const PROD_TEXT = `STRIPE_KEY=${SENTINEL}-prod-stripe\nNEW_KEY=${SENTINEL}-prod-new\n`;
    const args = (...more: string[]) => [
      "import",
      ".env.production",
      "--profile",
      "prod",
      "--vault",
      "App Secrets",
      ...more,
    ];

    test("with no map, names the items for that environment and writes its entries as tables", async () => {
      const { disk, fake, text, record } = setup({ files: { [PROD_ENV]: PROD_TEXT } });
      expect(await record("env-new-map", [...args("--account", ACCOUNT), "--yes"])).toBe(0);
      expect(fake.created.map((c) => c.ref.item)).toEqual([
        "billing prod stripe key",
        "billing prod new key",
      ]);
      const written = disk.contents.get(MAP) ?? "";
      const parsed = readSecretspec(written, MAP, destinations, issuers, vaults);
      assert(parsed.ok, JSON.stringify(parsed));
      expect(parsed.map.keys.map((k) => [k.name, Object.keys(k.environments)])).toEqual([
        ["STRIPE_KEY", ["prod"]],
        ["NEW_KEY", ["prod"]],
      ]);
      expect(text()).toContain("keypin run --profile prod -- <command> provides them");
      expect(leaks(text(), written)).toBe(false);
    });

    test("adds the environment to a key mapped only for dev, keeps the key as it is, and destinations can follow", async () => {
      const { deps, disk, fake, text } = setup({
        files: { [MAP]: REAL_MAP, [PROD_ENV]: PROD_TEXT },
      });
      expect(await cli([...args(), "--yes"], deps)).toBe(0);
      expect(fake.created.map((c) => c.ref.item)).toEqual([
        "billing prod stripe key",
        "billing prod new key",
      ]);
      const written = disk.contents.get(MAP) ?? "";
      expect(written.startsWith(REAL_MAP)).toBe(true);
      expect(written.match(/^\[tool\.keypin\.\w+\.STRIPE_KEY\]/gm)).toHaveLength(1);
      const parsed = readSecretspec(written, MAP, destinations, issuers, vaults);
      assert(parsed.ok, JSON.stringify(parsed));
      const stripe = parsed.map.keys.find((k) => k.name === "STRIPE_KEY");
      expect(stripe?.rotateEvery?.text).toBe("30d");
      expect(stripe?.environments.dev && formatReference(stripe.environments.dev.ref, vaults)).toBe(
        "op://App Secrets/billing dev stripe/password",
      );
      expect(
        stripe?.environments.prod && formatReference(stripe.environments.prod.ref, vaults),
      ).toBe("op://App Secrets/billing prod stripe key/password");
      expect(text()).toContain("Map: add 1 key, and prod for STRIPE_KEY at the end of");

      const withDestination = `${written}\n[[tool.keypin.prod.STRIPE_KEY.publish]]\nto = "github-actions"\nrepo = "acme/billing"\n`;
      const later = readSecretspec(withDestination, MAP, destinations, issuers, vaults);
      assert(later.ok, JSON.stringify(later));
      expect(
        later.map.keys.find((k) => k.name === "STRIPE_KEY")?.environments.prod?.publish,
      ).toEqual([{ to: "github-actions", repo: "acme/billing", account: "acme" }]);
    });

    test("never replaces an environment the key already has, even one with destinations", async () => {
      const map = `${REAL_MAP}

[profiles.prod.STRIPE_KEY]
description = "STRIPE_KEY"
ref = { item = "billing prod stripe", field = "password" }

[tool.keypin.prod.STRIPE_KEY]
publish = [{ to = "github-actions", repo = "acme/billing" }]
`;
      const { deps, disk, fake, text } = setup({
        files: { [MAP]: map, [PROD_ENV]: `STRIPE_KEY=${SENTINEL}-prod-stripe\n` },
        values: { "billing prod stripe": "another value" },
      });
      expect(await cli([...args(), "--yes"], deps)).toBe(0);
      expect(fake.created).toEqual([]);
      expect(disk.contents.get(MAP)).toBe(map);
      expect(squash(text())).toContain(
        `- STRIPE_KEY  skipped: already mapped in ${MAP}; left as it is, and it differs from the vault`,
      );
      expect(text()).toContain(`Nothing was imported, and ${MAP} wasn't changed.`);
      expect(leaks(text())).toBe(false);
    });

    test("a profile the file doesn't have is added, and a name keypin can't use is a usage error", async () => {
      const { deps, disk, fake } = setup({
        files: { [MAP]: REAL_MAP, [PROD_ENV]: PROD_TEXT },
      });
      const staging = ["import", ".env.production", "--profile", "staging", "--vault", "V"];
      expect(await cli([...staging, "--yes"], deps)).toBe(0);
      expect(fake.created.map((c) => c.ref.item)).toEqual([
        "billing staging stripe key",
        "billing staging new key",
      ]);
      expect(disk.contents.get(MAP)).toContain("[profiles.staging.NEW_KEY]");

      const bad = setup({ files: { [PROD_ENV]: PROD_TEXT } });
      const upper = ["import", ".env.production", "--profile", "Prod", "--vault", "V"];
      expect(await cli([...upper, "--account", ACCOUNT], bad.deps)).toBe(2);
      expect(bad.stderr.text).toContain("--profile is a profile name");
      expect(bad.fake.calls).toEqual([]);
    });

    test("a listed environment works with a custom list, and without --profile the first one is used", async () => {
      const map = `[project]\nname = "billing"\nrevision = "1.0"\n\n[defaults]\nproviders = ["onepassword://${ACCOUNT}@V"]\n\n[profiles.dev]\n\n[profiles.staging]\n\n[profiles.prod]\n`;
      const staging = setup({ files: { [MAP]: map, [PROD_ENV]: PROD_TEXT } });
      const run = ["import", ".env.production", "--profile", "staging", "--vault", "V", "--yes"];
      expect(await cli(run, staging.deps)).toBe(0);
      expect(staging.fake.created.map((c) => c.ref.item)).toEqual([
        "billing staging stripe key",
        "billing staging new key",
      ]);
      expect(staging.text()).toContain("keypin run --profile staging -- <command>");

      const plain = setup({ files: { [MAP]: map, [PROD_ENV]: `NEW_KEY=${SENTINEL}\n` } });
      const noFlag = ["import", ".env.production", "--vault", "V", "--yes"];
      expect(await cli(noFlag, plain.deps)).toBe(0);
      expect(plain.fake.created.map((c) => c.ref.item)).toEqual(["billing dev new key"]);
    });
  });

  test("a value with a $ is left in the file, since loaders differ on expanding it", async () => {
    const env = `BASE=${SENTINEL}\nTOKEN=hello$BASE\nESCAPED="hello\\$BASE"\n`;
    const { deps, fake, text } = setup({ files: { [ENV]: env } });
    expect(await cli([...NEW, "--yes"], deps)).toBe(0);
    expect(fake.created.map((c) => c.ref.item)).toEqual(["billing default base"]);
    expect(squash(text())).toContain("- TOKEN  skipped: the value has a $");
    expect(squash(text())).toContain("- ESCAPED  skipped: the value has a $");
    expect(text()).toContain("TOKEN, ESCAPED are still only in that file");
    expect(leaks(text())).toBe(false);
  });

  test("a map an appended table would break stops before the vault, and changes nothing", async () => {
    const inline = `profiles = { dev = { STRIPE_KEY = { description = "s", ref = { item = "s", field = "password" } } } }\n\n[project]\nname = "billing"\nrevision = "1.0"\n\n[defaults]\nproviders = ["onepassword://${ACCOUNT}@V"]\n`;
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
    expect(fake.created.map((c) => c.ref.item)).toEqual(["billing default api key"]);
    expect(squash(text())).toContain(
      `- api_key  skipped: its item would be "billing default api key", the same as API_KEY's`,
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

  test("with names, imports only those, and says which lines to remove, not that the rest is left", async () => {
    const env = [
      `STRIPE_KEY=${SENTINEL}-stripe`,
      "PUBLIC_SITE_URL=http://localhost:3000",
      `WEBHOOK_SECRET=${SENTINEL}-webhook`,
      "DATABASE_URL=postgres://localhost/billing",
      "",
    ].join("\n");
    const { disk, text, record } = setup({ files: { [ENV]: env } });
    const args = ["import", ".env", "STRIPE_KEY", "WEBHOOK_SECRET"];
    expect(
      await record("named", [...args, "--vault", "App Secrets", "--account", ACCOUNT, "--yes"]),
    ).toBe(0);
    const parsed = readSecretspec(disk.contents.get(MAP) ?? "", MAP, destinations, issuers, vaults);
    assert(parsed.ok);
    expect(disk.contents.get(ENV)).toBe(env);
    expect(leaks(text(), disk.contents.get(MAP) ?? "")).toBe(false);
  });

  test("with names, a name the file doesn't set is a usage error before the vault", async () => {
    const { deps, disk, fake, stderr } = setup();
    const args = ["import", ".env", "STRIPE_KEY", "MISSING", "OTHER", "--vault", "V"];
    expect(await cli([...args, "--account", ACCOUNT, "--yes"], deps)).toBe(2);
    expect(stderr.text).toContain(`${ENV} doesn't set MISSING, OTHER`);
    expect(fake.calls).toEqual([]);
    expect(disk.contents.has(MAP)).toBe(false);
  });

  test("with names, an empty or comment-only file is the same usage error", async () => {
    const { deps, fake, stderr } = setup({ files: { [ENV]: "# nothing set yet\n" } });
    const args = ["import", ".env", "STRIPE_KEY", "--vault", "V", "--account", ACCOUNT, "--yes"];
    expect(await cli(args, deps)).toBe(2);
    expect(stderr.text).toContain(`${ENV} doesn't set STRIPE_KEY`);
    expect(fake.calls).toEqual([]);
  });

  test("an empty line for a mapped variable is one to remove, not a reason to keep the file", async () => {
    const { deps, text } = setup({
      files: {
        [MAP]: REAL_MAP,
        [ENV]: `STRIPE_KEY=\nWEBHOOK_SECRET=${SENTINEL}-hook\nPUBLIC_URL=http://localhost:3000\n`,
      },
    });
    const args = ["import", ".env", "STRIPE_KEY", "WEBHOOK_SECRET", "--vault", "App Secrets"];
    expect(await cli([...args, "--yes"], deps)).toBe(0);
    expect(squash(text())).toContain("- STRIPE_KEY  skipped: the value is empty");
    expect(text()).toContain("Remove the STRIPE_KEY, WEBHOOK_SECRET lines from it");
    expect(text()).not.toContain("Delete it");
    expect(leaks(text())).toBe(false);
  });

  test("a .dev.vars with a setting left says to move it and delete the file, not to keep it", async () => {
    const devVars = `${ROOT}/.dev.vars`;
    const { deps, text } = setup({
      files: { [devVars]: `API_TOKEN=${SENTINEL}-token\nPORT=8787\n` },
    });
    const args = ["import", ".dev.vars", "API_TOKEN", "--vault", "V", "--account", ACCOUNT];
    expect(await cli([...args, "--yes"], deps)).toBe(0);
    expect(text()).toContain(
      "Delete it once PORT has a new home: while a .dev.vars file exists, wrangler dev reads secrets only from it and ignores the ones keypin run provides. Import a secret among them too. A plain setting that isn't secret can go to wrangler dev --var NAME:value; [vars] in the wrangler config also deploys.",
    );
    expect(text()).not.toContain("Remove the");
    expect(leaks(text())).toBe(false);

    const only = setup({ files: { [devVars]: `API_TOKEN=${SENTINEL}-token\n` } });
    expect(await cli([...args, "--yes"], only.deps)).toBe(0);
    expect(only.text()).toContain(
      "Nothing else is set in it. Delete it: while a .dev.vars file exists, wrangler dev ignores the secrets keypin run provides.",
    );
  });

  test("when nothing else is set in the file, says it can be deleted", async () => {
    const env = `STRIPE_KEY=${SENTINEL}-stripe\nEMPTY=\n`;
    const named = setup({ files: { [ENV]: env } });
    const args = ["import", ".env", "STRIPE_KEY", "--vault", "V", "--account", ACCOUNT, "--yes"];
    expect(await cli(args, named.deps)).toBe(0);
    expect(named.text()).toContain("Nothing else is set in it. Delete it and stop loading it");
    expect(named.text()).not.toContain("Remove the");

    const all = setup({ files: { [ENV]: env } });
    expect(await cli([...NEW, "--yes"], all.deps)).toBe(0);
    expect(all.text()).toContain("Nothing else is set in it. Delete it and stop loading it");
    expect(leaks(named.text(), all.text())).toBe(false);
  });

  test("a mapped variable that matches the vault is one of the lines to remove", async () => {
    const env = `STRIPE_KEY=${SENTINEL}-stripe\nWEBHOOK_SECRET=${SENTINEL}-webhook\nPORT=3000\n`;
    const { deps, text } = setup({
      files: { [ENV]: env, [MAP]: REAL_MAP },
      values: { "billing dev stripe": `${SENTINEL}-stripe` },
    });
    const args = ["import", ".env", "STRIPE_KEY", "WEBHOOK_SECRET", "--vault", "App Secrets"];
    expect(await cli([...args, "--yes"], deps)).toBe(0);
    expect(text()).toContain("Remove the STRIPE_KEY, WEBHOOK_SECRET lines from it");
    expect(text()).not.toContain("PORT");
    expect(leaks(text())).toBe(false);
  });

  test("usage errors: no --vault, no --account without a map, no file, an example file", async () => {
    const cases: [string[], string][] = [
      [["import", ".env", "--account", ACCOUNT], "--vault is required"],
      [["import", ".env", "--vault", "V"], "--account is required"],
      [["import", "--vault", "V", "--account", ACCOUNT], "takes an env file"],
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
