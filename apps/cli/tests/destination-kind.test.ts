import { describe, expect, test } from "vite-plus/test";
import { connectTo, type DestinationKind, type Discovery, isRecord, loadState } from "@keypin/core";
import { cli } from "../src/cli";
import { destinations, vaults } from "../src/start";
import { fakeDeps, fakeVault, memoryFiles, SENTINEL, STATE } from "./fakes";
import { recording } from "./recording";

type ShelfTarget = { to: "shelf"; account: string; shelf: string };

const written: string[] = [];
let shelfCli: "ok" | "not installed" = "ok";

let shelfReport: Record<string, unknown> = {};

const shelfFiles: Discovery = {
  files: { key: "shelves", noun: "shelf file", names: ["shelf.json"] },
  async scan(project) {
    const shelves: { path: string; account: string; shelf: string; needs: string[] }[] = [];
    for (const path of project.found) {
      const data: unknown = JSON.parse((await project.read(path)) ?? "null");
      if (!isRecord(data) || !Array.isArray(data.needs)) continue;
      const needs = data.needs.filter((n): n is string => typeof n === "string");
      shelves.push({ path, account: String(data.account), shelf: String(data.shelf), needs });
    }
    const discovered = {
      files: project.found,
      used: shelves.length > 0,
      about: null,
      report: shelfReport,
      needs: () => ({
        notes: [],
        needs: shelves.flatMap(({ path, account, shelf: name, needs }) =>
          needs.map((secret) => ({
            name: secret,
            usedBy: path,
            place: {
              id: `shelf:${name}`,
              to: "shelf",
              label: `the ${name} shelf`,
              verb: "needs",
              fields: [
                ["to", "shelf"],
                ["account", account],
                ["shelf", name],
              ] as const,
              matches: (keyName: string, wanted: string) => keyName === wanted,
              covers: (target: { to: string; shelf?: string }) =>
                target.to === "shelf" && target.shelf === name,
              holds: () => null,
            },
          })),
        ),
      }),
    };
    return { finish: async () => discovered };
  },
};

const shelf: DestinationKind<ShelfTarget> = {
  kind: "shelf",
  label: "Shelf",
  parse(read) {
    read.only(["account", "shelf"]);
    const account = read.required("account");
    const name = read.required("shelf");
    return account === undefined || name === undefined
      ? undefined
      : { to: "shelf", account, shelf: name };
  },
  id: ({ shelf: name }) => name,
  secretId: ({ account, shelf: name }, secret) => `${account}:${name}:${secret}`,
  checkId: ({ account, shelf: name }) => `${account}/${name}`,
  fromId: (id, account) => ({ to: "shelf", account, shelf: id }),
  describe: ({ shelf: name }) => `${name} shelf`,
  named: ({ shelf: name }) => `the ${name} shelf`,
  where: ({ shelf: name }) => `the ${name} shelf`,
  login: () => "the shelf key",
  discovery: shelfFiles,
  prerequisites: async ({ targets }) =>
    targets.length && shelfCli === "not installed"
      ? [
          {
            name: "Shelf",
            status: "not installed",
            fix: "install the shelf CLI, then run shelf login",
            title: "Install the shelf CLI",
            body: ["  brew install shelf", "  shelf login"],
            coversFailures: false,
          },
        ]
      : [],
  connect: ({ account, shelf: name }) => ({
    describe: () => `shelf ${name}`,
    checkAccount: async () => ({
      publisher: "librarian",
      destinationAccount: account,
      expected: account,
      ok: true,
    }),
    async write(secretName, secret) {
      written.push(`${name} ${secretName} ${secret.includes(SENTINEL) ? "the value" : "another"}`);
      return { shelf: name };
    },
  }),
};

const MAP = `
[project]
name = "billing"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Private"

[defaults]
providers = ["vault"]

[profiles.prod]
API_KEY = { description = "API_KEY", ref = { item = "api key", field = "password" } }

[tool.keypin.prod.API_KEY]
rotate_every = "90d"
publish = [{ to = "shelf", account = "library", shelf = "top" }]
`;

function setup(answer: string, files: Record<string, string> = {}) {
  const kinds = [...destinations, shelf];
  const disk = memoryFiles({ "/work/billing/secretspec.toml": MAP, ...files });
  const vault = fakeVault({ values: { "api key": SENTINEL } });
  const fake = fakeDeps({
    disk,
    backend: vault.vault,
    deps: {
      destinations: kinds,
      destination: (target, publisher) => connectTo(kinds, target, publisher),
      isTerminal: true,
      ask: async () => answer,
    },
  });
  const record = async (name: string, args: string[]) => {
    const before = new Map(disk.contents);
    const exit = await cli(args, fake.deps);
    await expect(
      recording({
        args,
        exit,
        stdout: fake.stdout.text,
        stderr: fake.stderr.text,
        files: Object.fromEntries(before),
        given: { "shelf CLI": shelfCli },
        calls: { vault: vault.calls },
      }),
    ).toMatchFileSnapshot(`./recordings/destination-kind/${name}.txt`);
    return exit;
  };
  return { ...fake, record, state: () => loadState(disk.files, STATE, vaults) };
}

describe("a destination kind defined outside keypin", () => {
  test("parses from secretspec.toml and shows its label in the plan", async () => {
    const run = setup("");
    await cli(["publish", "API_KEY", "--plan"], run.deps);
    expect(run.stderr.text).toContain("Shelf  top shelf  as librarian, account library");
    expect(run.stderr.text).toMatch(/\+ Shelf  top shelf  first write +needs approval/);
  });

  test("publishes through its own destination and keeps a receipt", async () => {
    written.length = 0;
    const run = setup("yes");
    expect(await cli(["publish", "API_KEY"], run.deps)).toBe(0);
    expect(written).toEqual(["top API_KEY the value"]);
    expect((await run.state()).receipts.map((r) => r.destinationId)).toEqual(["shelf:top:API_KEY"]);
  });
});

describe("a destination kind's own sign-in", () => {
  test("keypin check lists it first, with its fix", async () => {
    shelfCli = "not installed";
    const run = setup("");
    expect(await run.record("own-sign-in", ["check"])).toBe(0);
    const json = setup("");
    await cli(["check", "--json"], json.deps);
    expect(JSON.parse(json.stdout.text)).toMatchObject({
      prerequisites: [
        {
          name: "Shelf",
          status: "not installed",
          fix: "install the shelf CLI, then run shelf login",
        },
      ],
    });
    shelfCli = "ok";
    const ready = setup("");
    expect(await cli(["check"], ready.deps)).toBe(0);
    expect(ready.stdout.text).not.toContain("shelf CLI");
  });
});

describe("a destination kind's own discovery", () => {
  test("keypin check finds what its files need, and suggests the TOML to add", async () => {
    const shelfJson = JSON.stringify({
      account: "library",
      shelf: "bottom",
      needs: ["NEW_KEY"],
    });
    const run = setup("", { "/work/billing/shelf.json": shelfJson });
    expect(await run.record("own-discovery", ["check"])).toBe(1);
    expect(run.stdout.text).toContain("read 0 env files, 0 wrangler configs, 1 shelf file");
    expect(run.stdout.text).toContain(
      "NEW_KEY: shelf.json needs it; secretspec.toml doesn't publish it to the bottom shelf.",
    );
    const json = setup("", { "/work/billing/shelf.json": shelfJson });
    await cli(["check", "--json"], json.deps);
    expect(JSON.parse(json.stdout.text)).toMatchObject({
      read: { shelves: ["shelf.json"] },
      production: [{ name: "NEW_KEY", to: "shelf", place: "the bottom shelf", mapped: null }],
    });
  });
});

describe("a destination kind's report fields", () => {
  test("reach check --json under the kind's own key", async () => {
    shelfReport = { shelves: { count: 1 } };
    const run = setup("", { "/work/billing/shelf.json": "{}" });
    await cli(["check", "--json"], run.deps);
    shelfReport = {};
    expect(JSON.parse(run.stdout.text)).toMatchObject({ shelves: { count: 1 } });
  });

  test("can't replace a field keypin check owns", async () => {
    shelfReport = { read: "mine" };
    const run = setup("", { "/work/billing/shelf.json": "{}" });
    const code = await cli(["check", "--json"], run.deps);
    shelfReport = {};
    expect(code).toBe(1);
    expect(run.stderr.text).toContain(
      "a destination's discovery reports read, which keypin check owns",
    );
  });

  test("can't report the same field as another kind", async () => {
    shelfReport = { github: "mine" };
    const run = setup("", { "/work/billing/shelf.json": "{}" });
    const code = await cli(["check", "--json"], run.deps);
    shelfReport = {};
    expect(code).toBe(1);
    expect(run.stderr.text).toContain(
      "the github-actions and shelf destinations both report github",
    );
  });
});
