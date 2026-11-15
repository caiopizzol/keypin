import { describe, expect, test } from "vite-plus/test";
import { connectTo, type DestinationKind, loadState } from "@keypin/core";
import { cli } from "../src/cli";
import { destinations, vaults } from "../src/start";
import { fakeDeps, fakeVault, memoryFiles, SENTINEL, STATE } from "./fakes";

type ShelfTarget = { to: "shelf"; account: string; shelf: string };

const written: string[] = [];
let shelfCli: "ok" | "not installed" = "ok";

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
    capabilities: { write: true, accountCheck: true, evidence: true },
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
[1password]
account = "my.1password.com"

[keys.API_KEY]
rotate_every = "90d"
prod = { from = "op://Private/api key/password", publish = [
  { to = "shelf", account = "library", shelf = "top" },
] }
`;

function setup(answer: string) {
  const kinds = [...destinations, shelf];
  const disk = memoryFiles({ "/work/billing/keypin.toml": MAP });
  const fake = fakeDeps({
    disk,
    backend: fakeVault({ values: { "api key": SENTINEL } }).vault,
    deps: {
      destinations: kinds,
      destination: (target, publisher) => connectTo(kinds, target, publisher),
      isTerminal: true,
      ask: async () => answer,
    },
  });
  return { ...fake, state: () => loadState(disk.files, STATE, vaults) };
}

describe("a destination kind defined outside keypin", () => {
  test("parses from keypin.toml and shows its label in the plan", async () => {
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
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stdout.text).toContain(
      "1 thing to do:\n1 Install the shelf CLI\n    brew install shelf\n    shelf login\n",
    );
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
