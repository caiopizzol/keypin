import { describe, expect, test } from "vite-plus/test";
import { generationOf, loadState, Secret } from "@keypin/core";
import { cli } from "../src/cli";
import type { RandomSpec } from "@keypin/connectors/rules";
import { RandomIssuer } from "../src/random";
import { issuer, vaults } from "../src/start";
import { NEEDS_APPROVAL } from "../src/approval";
import {
  fakeDeps,
  fakeDestinations,
  type FakeDestinationOptions,
  memoryFiles,
  STATE,
  writableVault,
} from "./fakes";
import { changes, recording } from "./recording";

const OLD = "auth_secret_old_sentinel_3f9a";
const GITHUB = "github-actions:acme/app";

const mapFor = (name: string, issuerTable = `{ kind = "random" }`) => `
[1password]
account = "my.1password.com"

[keys.${name}.prod]
from = "op://Private/app secret/password"
publish = [{ to = "github-actions", repo = "acme/app" }]
issuer = ${issuerTable}
`;

interface Setup extends FakeDestinationOptions {
  map?: string;
  answers?: string[];
  terminal?: boolean;
  disk?: ReturnType<typeof memoryFiles>;
  vault?: ReturnType<typeof writableVault>;
  failSave?: boolean | "refused";
}

function setup(options: Setup = {}) {
  const disk =
    options.disk ??
    memoryFiles({ "/work/billing/keypin.toml": options.map ?? mapFor("AUTH_SECRET") });
  const vault = options.vault ?? writableVault({ "app secret": OLD }, options.failSave);
  const destinations = fakeDestinations(options);
  const answers = [...(options.answers ?? [])];
  const asked: string[] = [];
  const fake = fakeDeps({
    disk,
    backend: vault.vault,
    deps: {
      destination: destinations.build,
      issuer,
      isTerminal: options.terminal ?? true,
      ask: async (question) => {
        asked.push(question);
        return answers.shift() ?? "";
      },
    },
  });
  const run = (key = "AUTH_SECRET", ...args: string[]) => cli(["rotate", key, ...args], fake.deps);
  const saved = () => vault.values.get("app secret") ?? "";
  const leaked = () => {
    const seen = [fake.stdout.text, fake.stderr.text, ...disk.contents.values()].join("\n");
    return [OLD, saved()].some((value) => seen.includes(value));
  };
  const given = { answers: [...answers], terminal: options.terminal ?? true };
  const record = async (name: string) => {
    const before = new Map(disk.contents);
    const start = vault.log.length;
    const exit = await run();
    const generation = await generationOf(new Secret(saved()));
    await expect(
      recording({
        args: ["rotate", "AUTH_SECRET"],
        exit,
        stdout: fake.stdout.text,
        stderr: fake.stderr.text,
        files: Object.fromEntries(before),
        given,
        calls: { vault: vault.log.slice(start), destination: destinations.log, asked },
        wrote: changes(before, disk.contents),
      }).replaceAll(generation, "<generation of the new value>"),
    ).toMatchFileSnapshot(`./recordings/random/${name}.txt`);
    return exit;
  };
  return { ...fake, disk, vault, destinations, asked, run, record, saved, leaked };
}

describe("the random issuer", () => {
  test("makes 32 random bytes, base64 by default and hex when asked, never the same twice", async () => {
    const base64 = new RandomIssuer("base64");
    const first = (await base64.create("AUTH_SECRET")).secret.reveal();
    const second = (await base64.create("AUTH_SECRET")).secret.reveal();
    expect(Buffer.from(first, "base64")).toHaveLength(32);
    expect(first).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(second).not.toBe(first);
    const hex = (await new RandomIssuer("hex").create("AUTH_SECRET")).secret.reveal();
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  test("has nothing to revoke", () => {
    expect("revoke" in new RandomIssuer("base64")).toBe(false);
  });

  test("an encoding it doesn't know, an admin key or another field is refused", async () => {
    for (const [table, error] of [
      [`{ kind = "random", encoding = "base32" }`, `field "encoding" must be one of: base64, hex`],
      [
        `{ kind = "random", admin = "op://Private/admin/password" }`,
        `unknown field "admin" for random`,
      ],
      [`{ kind = "random", length = "64" }`, `unknown field "length" for random`],
    ]) {
      const run = setup({ map: mapFor("AUTH_SECRET", table) });
      expect(await run.run()).toBe(1);
      expect(run.stderr.text).toContain(`key "AUTH_SECRET" prod: issuer: ${error}`);
      expect(run.vault.log).toEqual([]);
    }
  });

  for (const name of ["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS"])
    test(`refuses ${name}, whose old value Better Auth needs to read stored data`, async () => {
      const run = setup({ map: mapFor(name) });
      expect(await run.run(name)).toBe(1);
      expect(run.stderr.text).toContain(
        `key "${name}" prod: issuer: random can't rotate this key, because Better Auth encrypts two-factor secrets and OAuth tokens with it, and a new value can't read them. Add a version to BETTER_AUTH_SECRETS by hand instead: https://better-auth.com/docs/reference/options#secrets`,
      );
      expect(run.vault.log).toEqual([]);
      expect(run.destinations.log).toEqual([]);
    });
});

describe("keypin rotate with a random issuer", () => {
  test("reads no admin key, says everyone signs in again, saves, publishes and asks one y", async () => {
    const run = setup({ answers: ["y"] });
    expect(await run.record("rotates")).toBe(0);
    expect(run.asked).toEqual(["Rotate AUTH_SECRET? [y/N] "]);
    expect(run.vault.log).toEqual(["read app secret", "save app secret", "ids app secret"]);
    expect(run.saved()).not.toBe(OLD);
    expect(run.destinations.delivered(run.saved())).toEqual([`${GITHUB} AUTH_SECRET`]);
    expect(run.stderr.text).toContain("ok     Read the key op://Private/app secret/password\n");
    expect(run.stderr.text).toContain(
      "Nothing to revoke: the old value stops working once your apps use the new one.",
    );
    expect(run.stderr.text).not.toContain("admin key");
    expect(run.leaked()).toBe(false);
    const { issued } = await loadState(run.disk.files, STATE, vaults);
    expect(issued.map((each) => [each.issuer, each.old.revoked])).toEqual([["random", true]]);
  });

  test("a second rotation makes another value and still asks one y", async () => {
    const first = setup({ answers: ["y"] });
    await first.run();
    const value = first.saved();
    const again = setup({ disk: first.disk, vault: first.vault, answers: ["y"] });
    expect(await again.run()).toBe(0);
    expect(again.asked).toEqual(["Rotate AUTH_SECRET? [y/N] "]);
    expect(again.saved()).not.toBe(value);
    expect(again.stderr.text).not.toContain("delete it at");
  });

  test("a failed destination stops, and the rerun publishes the saved value without making another", async () => {
    const first = setup({ failWrite: [GITHUB], answers: ["y"] });
    expect(await first.run()).toBe(1);
    const value = first.saved();
    expect(value).not.toBe(OLD);
    const again = setup({ disk: first.disk, vault: first.vault, answers: ["y"] });
    expect(await again.run()).toBe(0);
    expect(again.stderr.text).toContain("Resuming");
    expect(again.asked).toEqual(["Write 1 secret? [y/N] "]);
    expect(again.saved()).toBe(value);
    expect(again.destinations.delivered(value)).toEqual([`${GITHUB} AUTH_SECRET`]);
  });

  test("a refused save keeps the old value and says nothing changed", async () => {
    const run = setup({ failSave: "refused", answers: ["y"] });
    expect(await run.run()).toBe(1);
    expect(run.saved()).toBe(OLD);
    expect(run.stderr.text).toContain(
      "Stopped: 1Password refused to save the new key. The new value was never saved, so nothing changed.",
    );
    expect(run.destinations.log.some((line) => line.startsWith("write"))).toBe(false);
  });

  test("without a terminal, --yes publishes a routine rotation and asks nothing more", async () => {
    const first = setup({ answers: ["y"] });
    await first.run();
    const run = setup({ disk: first.disk, vault: first.vault, terminal: false });
    expect(await run.run("AUTH_SECRET", "--yes")).toBe(0);
    expect(run.asked).toEqual([]);
    expect(run.stderr.text).not.toContain("needs a y in a terminal");
  });

  test("declining the rotation saves and writes nothing", async () => {
    const run = setup({ answers: ["n"] });
    expect(await run.run()).toBe(NEEDS_APPROVAL);
    expect(run.saved()).toBe(OLD);
    expect(run.destinations.log.some((line) => line.startsWith("write"))).toBe(false);
  });
});

describe("keypin rotate with a random issuer in a vault that holds changes for approval", () => {
  test("refuses before reading anything and says to publish a value by hand", async () => {
    const map = `
[infisical]
organization = "acme"

[keys.AUTH_SECRET.prod]
from = "infisical://app/prod/AUTH_SECRET"
publish = [{ to = "github-actions", repo = "acme/app" }]
issuer = { kind = "random" }
`;
    const run = setup({ map });
    expect(await run.run()).toBe(1);
    expect(run.stderr.text).toContain(
      "keypin rotate: Infisical may hold a change for approval, and keypin couldn't tell later whether the random value it made was approved or rejected, so it can't rotate AUTH_SECRET. Make a new value yourself, save it, then run keypin publish AUTH_SECRET.",
    );
    expect(run.vault.log).toEqual([]);
  });
});

test("the issuer keypin connects for random takes no admin key", () => {
  const spec: RandomSpec = { kind: "random", encoding: "hex" };
  const made = issuer(spec, null);
  expect(made.describe()).toBe("random");
  expect(() => issuer({ kind: "resend" }, null)).toThrow(`the "resend" issuer needs an admin key`);
});
