import { assert, describe, expect, test } from "vite-plus/test";
import {
  isRecord,
  type Issuer,
  type KeyRef,
  loadState,
  Secret,
  type VaultBackend,
  type VaultKind,
} from "@keypin/core";
import { day } from "@keypin/core/testing";
import { cli } from "../src/cli";
import { vaults } from "../src/start";
import { routedVault } from "../src/vault";
import {
  fakeDeps,
  fakeDestinations,
  fakeLauncher,
  fakeVault,
  memoryFiles,
  REGISTRY,
  registryWith,
  SENTINEL,
  STATE,
} from "./fakes";

type ToyRef = { kind: "toy"; box: string; shelf: string; slot: string };
type ToyReference = Omit<ToyRef, "box">;

function toyRef(value: unknown): ToyRef | null {
  if (!isRecord(value) || value.kind !== "toy") return null;
  const { box, shelf, slot } = value;
  return typeof box === "string" && typeof shelf === "string" && typeof slot === "string"
    ? { kind: "toy", box, shelf, slot }
    : null;
}

const toy: VaultKind<unknown, ToyRef, ToyReference> = {
  kind: "toy",
  name: "Toy",
  scheme: "toy://",
  placeholder: "the shelf and slot",
  parse(rest) {
    const [shelf, slot, ...more] = rest.split("/");
    return shelf && slot && !more.length
      ? { kind: "toy", shelf, slot }
      : "must be toy://<shelf>/<slot>";
  },
  pinned: (reference, { box }) => ({ ...reference, box }),
  format: ({ shelf, slot }) => `toy://${shelf}/${slot}`,
  account: ({ box }) => `toy box ${box}`,
  sameItem: (a, b) => a.shelf === b.shelf && a.slot === b.slot,
  stored: toyRef,
  secretspec: {
    provider: "toy",
    locate: ({ uri, ref }) => {
      const box = uri.slice("toy://".length);
      const shelf = ref?.shelf;
      const slot = ref?.slot;
      if (!box) return `uses ${uri}, which names no toy box`;
      return typeof shelf === "string" && typeof slot === "string"
        ? { kind: "toy", box, shelf, slot }
        : `a toy needs ref = { shelf = "...", slot = "..." }`;
    },
  },
  signInVariables: ["TOY_KEY_RING"],
  newValueByHand: "Put a new toy in the slot and write today on its tag",
  addRotatedDate: "Write the day the toy last changed on its tag.",
};

const toyBackend = (values: Record<string, string>, reads: KeyRef[]): VaultBackend => {
  const stored = (ref: KeyRef) => {
    const mine = toyRef(ref);
    const found = mine && values[`${mine.shelf}/${mine.slot}`];
    if (!found) throw new Error(`no toy at ${String(mine?.slot)}`);
    return found;
  };
  const value = (ref: KeyRef) => {
    reads.push(ref);
    return new Secret(stored(ref));
  };
  const ids = (ref: KeyRef) => ({ vault: "toy", item: toyRef(ref)?.slot ?? "" });
  return {
    read: async (ref) => value(ref),
    readItem: async (ref) => ({ secret: value(ref), ids: ids(ref) }),
    itemIds: async (ref) => (stored(ref), ids(ref)),
    write: async () => {
      throw new Error("the toy vault doesn't write");
    },
    list: async () => [],
    metadata: async (ref) => ({
      rotated: toyRef(ref)?.slot === "right" ? null : day("2026-11-01"),
    }),
  };
};

const MAP = `
[project]
name = "billing"
revision = "1.0"

[providers]
attic = "toy://attic"
acme = "onepassword://my.1password.com@Private"

[defaults]
providers = ["attic"]

[profiles.dev]
TOY_KEY = { description = "toy", ref = { shelf = "top", slot = "left" } }
OTHER_KEY = { description = "other", providers = ["acme"], ref = { item = "other key", field = "password" } }

[profiles.prod]
TOY_KEY = { description = "toy", ref = { shelf = "top", slot = "right" } }

[tool.keypin.prod.TOY_KEY]
publish = [{ to = "github-actions", repo = "acme/billing" }]
`;

const issuer = (): Issuer => ({
  describe: () => "Resend",
  dashboard: () => "https://resend.com/api-keys",
  checkAccount: async () => ({ ok: true, facts: "the admin key lists 1 API key" }),
  create: async () => ({ id: "key-1", secret: new Secret(`${SENTINEL}-new`) }),
  revoke: async () => "revoked",
});

function setup(map = MAP, env: Record<string, string> = {}) {
  const disk = memoryFiles({
    "/work/billing/secretspec.toml": map,
    [REGISTRY]: registryWith("/work/billing"),
  });
  const launcher = fakeLauncher();
  const reads: KeyRef[] = [];
  const fake = fakeDeps({
    disk,
    backend: routedVault({
      toy: () => toyBackend({ "top/left": SENTINEL, "top/right": `${SENTINEL}-prod` }, reads),
      "1password": () => fakeVault({ values: { "other key": `${SENTINEL}-other` } }).vault,
    }),
    deps: {
      env,
      vaults: [...vaults, toy],
      issuer,
      launch: launcher.launch,
      onSignals: launcher.onSignals,
      destination: fakeDestinations().build,
      isTerminal: true,
      ask: async () => "y",
    },
  });
  return { ...fake, disk, launcher, reads };
}

describe("a vault kind defined outside keypin", () => {
  test("finds its secrets in secretspec.toml, with its own errors", async () => {
    const run = setup(
      `[project]\nname = "billing"\nrevision = "1.0"\n\n[profiles.dev]\nA = { description = "a", providers = ["toy://attic"], ref = { shelf = "top" } }\nB = { description = "b", providers = ["toy://"], ref = { shelf = "top", slot = "left" } }\nC = { description = "c", providers = ["vault://x"] }\n`,
    );
    expect(await cli(["check"], run.deps)).toBe(1);
    expect(run.stdout.text).toContain(
      `[profiles.dev] A: a toy needs ref = { shelf = "...", slot = "..." }`,
    );
    expect(run.stdout.text).toContain(`[profiles.dev] B: uses toy://, which names no toy box`);
    expect(run.stdout.text).toContain(
      `[profiles.dev] C: uses vault://x, and keypin reads only Infisical, Bitwarden, 1Password and Toy from secretspec.toml`,
    );
  });

  test("check looks its items up and names its account", async () => {
    const run = setup();
    expect(await cli(["check"], run.deps)).toBe(0);
    expect(run.stderr.text).toContain(
      "Looked up 3 items in 1Password account my.1password.com and toy box attic, not the values",
    );
    expect(run.reads).toEqual([]);
  });

  test("rotate names the vault by its kind's name", async () => {
    const run = setup(
      MAP.replace(
        "publish = [",
        'issuer = { kind = "resend", admin = "toy://top/left", permission = "sending_access" }\npublish = [',
      ),
    );
    expect(await cli(["rotate", "TOY_KEY"], run.deps)).toBe(1);
    expect(run.stderr.text).toMatch(/~ Toy +save it to toy:\/\/top\/right, rotated today/);
    expect(run.stderr.text).toContain("keypin can't tell whether Toy saved the new key");
  });

  test("status gives its own next steps for a key without a rotation date", async () => {
    const run = setup(
      MAP.replace("[tool.keypin.prod.TOY_KEY]", '[tool.keypin.prod.TOY_KEY]\nrotate_every = "90d"'),
    );
    await cli(["status"], run.deps);
    expect(run.stdout.text).toContain(
      "TOY_KEY (prod): no rotated date\n    Write the day the toy last changed on its tag.",
    );
    expect(run.stdout.text).toContain(
      "OTHER_KEY (dev): no rotated date\n    Add a rotated Date field to the 1Password item",
    );
  });

  test("its reference round-trips through state.json and still matches the map", async () => {
    const run = setup();
    expect(await cli(["publish", "TOY_KEY"], run.deps)).toBe(0);
    expect(run.stderr.text).toContain("from toy://top/right in toy box attic");
    const saved = run.disk.contents.get(STATE);
    assert(saved !== undefined);
    expect(saved).toContain('"kind": "toy"');
    const [receipt] = (await loadState(run.disk.files, STATE, [...vaults, toy])).receipts;
    expect(receipt?.source).toEqual({ kind: "toy", shelf: "top", slot: "right", box: "attic" });

    const again = setup();
    again.disk.contents.set(STATE, saved);
    await cli(["publish", "TOY_KEY", "--plan"], again.deps);
    expect(again.stderr.text).toMatch(/= GitHub +acme\/billing +already has this value/);
    expect(again.stderr.text).not.toContain("was last published from");
  });
});
