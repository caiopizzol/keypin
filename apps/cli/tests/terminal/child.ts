import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord, type PublishTarget } from "@keypin/core";
import {
  type Field,
  type FullItem,
  onePasswordBackend,
  requireDesktopApp,
  type SdkClient,
} from "@keypin/vault-1password";
import { cli } from "../../src/cli";
import { realDeps } from "../../src/start";
import { type FakeItem, placeOf, SANDBOX_MARKER, type Scenario, scenarios } from "./scenarios";

export const ACCOUNT_NOT_FOUND =
  "An error occurred when processing SDK request: Error { msg: Account not found, inner: None }";

const sandbox = process.env.KEYPIN_VERIFY_SANDBOX ?? "";
const scenario = scenarios[process.env.KEYPIN_VERIFY_SCENARIO ?? ""];
const inside = (path: string) => path.startsWith(`${sandbox}/`);
function marked(): boolean {
  try {
    return readFileSync(join(sandbox, SANDBOX_MARKER), "utf8") === process.env.KEYPIN_VERIFY_NONCE;
  } catch {
    return false;
  }
}
if (
  !sandbox ||
  !scenario ||
  !inside(homedir()) ||
  !inside(realpathSync(process.cwd())) ||
  !sandbox.startsWith(realpathSync(tmpdir())) ||
  !marked()
) {
  process.stderr.write("child.ts runs only inside a sandbox that drive.ts made\n");
  process.exit(70);
}

const EFFECTS = join(sandbox, "effects.txt");
const VAULT = join(sandbox, "onepassword.json");

function effect(line: string): void {
  appendFileSync(EFFECTS, `${line}\n`);
}

interface Stored extends FakeItem {
  account: string;
  vault: string;
}

function stored(): Stored[] {
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(readFileSync(VAULT, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown): Stored[] => {
    if (!isRecord(entry)) return [];
    const { account, vault, title, value, rotated } = entry;
    if (typeof account !== "string" || typeof vault !== "string") return [];
    if (typeof title !== "string" || typeof value !== "string") return [];
    return [{ account, vault, title, value, ...(typeof rotated === "string" ? { rotated } : {}) }];
  });
}

function save(item: Stored): void {
  const others = stored().filter(
    (s) => !(s.account === item.account && s.vault === item.vault && s.title === item.title),
  );
  writeFileSync(VAULT, JSON.stringify([...others, item]));
}

function itemsOf(account: string, vault: string, scenario: Scenario): FakeItem[] {
  const base = scenario.onePassword.accounts[account]?.[vault] ?? [];
  const added = stored().filter((s) => s.account === account && s.vault === vault);
  return [...base.filter((b) => !added.some((a) => a.title === b.title)), ...added];
}

function full(vault: string, item: FakeItem): FullItem {
  const fields: Field[] = [
    { id: "password", title: "password", fieldType: "Concealed", value: item.value },
  ];
  if (item.rotated)
    fields.push({ id: "rotated", title: "rotated", fieldType: "Date", value: item.rotated });
  return {
    id: item.title,
    title: item.title,
    category: "Password",
    vaultId: vault,
    fields,
    sections: [],
    notes: "",
    tags: [],
    websites: [],
    version: 1,
    files: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function client(account: string, scenario: Scenario): SdkClient {
  const vaults = () => Object.keys(scenario.onePassword.accounts[account] ?? {});
  const value = (fields: readonly Field[] | undefined, title: string) =>
    fields?.find((field) => field.title === title)?.value;
  const keep = (vault: string, title: string, fields: readonly Field[] | undefined) => {
    const rotated = value(fields, "rotated");
    save({
      account,
      vault,
      title,
      value: value(fields, "password") ?? "",
      ...(rotated ? { rotated } : {}),
    });
  };
  return {
    vaults: { list: async () => vaults().map((title) => ({ id: title, title })) },
    items: {
      list: async (vault) =>
        itemsOf(account, vault, scenario).map((item) => ({
          id: item.title,
          title: item.title,
          tags: [],
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        })),
      get: async (vault, id) => {
        const item = itemsOf(account, vault, scenario).find((i) => i.title === id);
        if (!item) throw new Error(`no item ${id}`);
        return full(vault, item);
      },
      create: async (params) => {
        keep(params.vaultId, params.title, params.fields);
        effect(`1password create ${account}/${params.vaultId}/${params.title}`);
        return {};
      },
      put: async (item) => {
        keep(item.vaultId, item.title, item.fields);
        effect(`1password update ${account}/${item.vaultId}/${item.title}`);
        return item;
      },
    },
  };
}

function owner(target: PublishTarget): string {
  return target.to === "cloudflare-worker" ? target.account : (target.repo.split("/")[0] ?? "");
}

const run = scenario;
const vault = onePasswordBackend(
  requireDesktopApp(
    async (account) => {
      if (run.onePassword.slowMs) await Bun.sleep(run.onePassword.slowMs);
      if (!run.onePassword.accounts[account]) throw new Error(ACCOUNT_NOT_FOUND);
      return client(account, run);
    },
    () => (run.onePassword.noDesktopApp ? null : "fake 1Password app"),
  ),
);
const real = realDeps();

process.exitCode = await cli(process.argv.slice(2), {
  ...real,
  self: { folder: real.cwd, command: ["keypin"] },
  vault: () => vault,
  ghLogin: async () => run.gh,
  wranglerLoginFile: async () =>
    run.wrangler ? join(homedir(), ".wrangler/config/default.toml") : null,
  githubSecrets: async () =>
    run.githubSecrets
      ? { ok: true, secrets: run.githubSecrets.map((name) => ({ name, updatedAt: null })) }
      : {
          ok: false,
          reason: "gh has no token for an active login; run: gh auth login --hostname github.com",
        },
  workerSecrets: async () => ({ ok: false, reason: "this scenario has no Cloudflare account" }),
  destination: (target) => {
    const place = placeOf(target);
    const scripted = run.places[place] ?? {};
    return {
      capabilities: { write: true, accountCheck: true, evidence: true },
      describe: () => place,
      async checkAccount() {
        const failed = scripted.check;
        if (!failed)
          return {
            publisher: owner(target),
            destinationAccount: owner(target),
            expected: target.account,
            ok: true,
          };
        return {
          publisher: failed.publisher ?? owner(target),
          destinationAccount: failed.destinationAccount ?? null,
          expected: target.account,
          ok: false,
          reason: failed.reason,
          ...(failed.fix ? { fix: failed.fix } : {}),
        };
      },
      async write(name, secret) {
        if (scripted.write) throw new Error(scripted.write);
        effect(`destination write ${place} ${name} (${secret.reveal().length} chars)`);
        return { destination: place, version: "verify" };
      },
    };
  },
});
