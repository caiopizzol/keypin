import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Fetch, isRecord, placeId, type PublishTarget } from "@keypin/core";
import {
  type Field,
  type FullItem,
  requireDesktopApp,
  type SdkClient,
  signInAddress,
} from "@keypin/connectors/onepassword";
import { fakeSignIn, type TokenWorld, tokensFetch } from "@keypin/connectors/cloudflare/testing";
import { neonFetch, type NeonWorld } from "@keypin/connectors/neon/testing";
import { type OpenAIKeys, openaiFetch } from "@keypin/connectors/openai/testing";
import { resendFetch } from "@keypin/connectors/resend/testing";
import { supabaseFetch, type SupabaseWorld } from "@keypin/connectors/supabase/testing";
import { credentialsFrom, infisicalBackend } from "@keypin/connectors/infisical";
import { fileStore, infisicalFetch } from "@keypin/connectors/infisical/testing";
import { dopplerBackend, tokenFrom } from "@keypin/connectors/doppler";
import { dopplerFetch, fileStore as dopplerStore } from "@keypin/connectors/doppler/testing";
import { cli } from "../../src/cli";
import { onePasswordFrom } from "../../src/sign-in";
import { destinations, issuer, realDeps } from "../../src/start";
import { routedVault } from "../../src/vault";
import {
  CLOUDFLARE_ADMIN,
  CLOUDFLARE_PREFIX,
  type FakeItem,
  ISSUED_PREFIX,
  RESEND_ADMIN,
  RESEND_KNOWN,
  NEON_HOST,
  NEON_PREFIX,
  OPENAI_ADMIN,
  OPENAI_PREFIX,
  SUPABASE_ADMIN,
  SUPABASE_PREFIX,
  SANDBOX_MARKER,
  type Scenario,
  scenarios,
} from "./scenarios";

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
const RESEND = join(sandbox, "resend.json");
const NEON = join(sandbox, "neon.json");
const OPENAI = join(sandbox, "openai.json");
const SUPABASE = join(sandbox, "supabase.json");
const CLOUDFLARE = join(sandbox, "cloudflare-tokens.json");

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
    { id: "credential", title: "credential", fieldType: "Concealed", value: item.value },
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
  const keep = (vault: string, title: string, fields: readonly Field[] | undefined): number => {
    const before = itemsOf(account, vault, scenario).find((item) => item.title === title)?.value;
    const edited = ["password", "credential"]
      .map((field) => value(fields, field))
      .find((v) => v !== undefined && v !== before);
    const rotated = value(fields, "rotated");
    const saved = edited ?? before ?? "";
    save({ account, vault, title, value: saved, ...(rotated ? { rotated } : {}) });
    return saved.length;
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
        const chars = keep(params.vaultId, params.title, params.fields);
        effect(`1password create ${account}/${params.vaultId}/${params.title} (${chars} chars)`);
        return {};
      },
      put: async (item) => {
        const chars = keep(item.vaultId, item.title, item.fields);
        effect(`1password update ${account}/${item.vaultId}/${item.title} (${chars} chars)`);
        if (scenario.onePassword.saveTimesOut) throw new Error("the request timed out");
        return item;
      },
    },
  };
}

function owner(target: PublishTarget): string {
  return target.account;
}

const run = scenario;

const slow = async () => {
  if (run.onePassword.slowMs) await Bun.sleep(run.onePassword.slowMs);
};
let onePassword: ReturnType<typeof onePasswordFrom> | undefined;
const signedIn = () =>
  (onePassword ??= onePasswordFrom(process.env, {
    desktop: requireDesktopApp(
      async (account) => {
        await slow();
        if (!run.onePassword.accounts[account]) throw new Error(ACCOUNT_NOT_FOUND);
        return client(account, run);
      },
      () => (run.onePassword.noDesktopApp ? null : "fake 1Password app"),
    ),
    token: async (token) => {
      await slow();
      return client(signInAddress(token), run);
    },
  }));
const INFISICAL = join(sandbox, "infisical.json");
const infisical = infisicalBackend(
  credentialsFrom(process.env),
  infisicalFetch(
    run.infisical ?? { organization: "", projects: {} },
    fileStore(
      () => (existsSync(INFISICAL) ? readFileSync(INFISICAL, "utf8") : null),
      (text) => writeFileSync(INFISICAL, text),
      effect,
    ),
  ),
);
const DOPPLER = join(sandbox, "doppler.json");
const doppler = dopplerBackend(
  tokenFrom(process.env),
  dopplerFetch(
    run.doppler ?? { workplace: "", projects: {}, tokens: {} },
    dopplerStore(
      () => (existsSync(DOPPLER) ? readFileSync(DOPPLER, "utf8") : null),
      (text) => writeFileSync(DOPPLER, text),
      effect,
    ),
  ),
);
const vault = routedVault({
  "1password": () => signedIn().vault,
  infisical: () => infisical,
  doppler: () => doppler,
});

const resend = resendFetch({
  admin: RESEND_ADMIN,
  known: RESEND_KNOWN,
  ...(run.resend?.domains === undefined ? {} : { domains: run.resend.domains }),
  tokenPrefix: ISSUED_PREFIX,
  ...(run.resend?.failCreate === undefined ? {} : { failCreate: run.resend.failCreate }),
  loseCreated: run.resend?.loseCreated ?? false,
  keys: {
    load() {
      if (!existsSync(RESEND)) return { live: run.resend?.keys ?? [], created: 0 };
      const parsed: unknown = JSON.parse(readFileSync(RESEND, "utf8"));
      if (!isRecord(parsed) || !Array.isArray(parsed.live) || typeof parsed.created !== "number")
        throw new Error(`${RESEND} isn't the fake Resend's keys`);
      const names = isRecord(parsed.names) ? parsed.names : {};
      return {
        live: parsed.live.filter((id): id is string => typeof id === "string"),
        created: parsed.created,
        names: Object.fromEntries(
          Object.entries(names).flatMap(([id, name]) =>
            typeof name === "string" ? [[id, name]] : [],
          ),
        ),
      };
    },
    save: (keys) => writeFileSync(RESEND, JSON.stringify(keys)),
  },
  effect,
});

const neon = neonFetch({
  projectId: "quiet-lake-12345678",
  branchId: "br-main-a1b2c3d4",
  database: "appdb",
  host: NEON_HOST.replace("-pooler", ""),
  passwordPrefix: NEON_PREFIX,
  world: {
    load() {
      if (existsSync(NEON)) {
        const parsed: unknown = JSON.parse(readFileSync(NEON, "utf8"));
        if (!isNeonWorld(parsed)) throw new Error(`${NEON} isn't the fake Neon's roles`);
        return parsed;
      }
      const roles = Object.entries(run.neon?.roles ?? {});
      return {
        roles: Object.fromEntries(roles.map(([name, password]) => [name, { password, resets: 0 }])),
        operations: {},
        made: 0,
      };
    },
    save: (world) => writeFileSync(NEON, JSON.stringify(world)),
  },
  effect,
});

const openai = openaiFetch({
  admin: OPENAI_ADMIN,
  projectId: "proj_verify",
  projectName: "billing",
  tokenPrefix: OPENAI_PREFIX,
  loseCreated: run.openai?.loseCreated ?? false,
  keys: {
    load(): OpenAIKeys {
      if (!existsSync(OPENAI)) return { live: run.openai?.keys ?? [], created: 0 };
      const parsed: unknown = JSON.parse(readFileSync(OPENAI, "utf8"));
      if (!isOpenAIKeys(parsed)) throw new Error(`${OPENAI} isn't the fake OpenAI's keys`);
      return parsed;
    },
    save: (keys) => writeFileSync(OPENAI, JSON.stringify(keys)),
  },
  effect,
});

const supabase = supabaseFetch({
  admin: SUPABASE_ADMIN,
  projectRef: "abcdefghijklmnopqrst",
  valuePrefix: SUPABASE_PREFIX,
  loseCreated: run.supabase?.loseCreated ?? false,
  prefixOnly: run.supabase?.prefixOnly ?? false,
  world: {
    load() {
      if (!existsSync(SUPABASE)) return { keys: run.supabase?.keys ?? [], created: 0 };
      const parsed: unknown = JSON.parse(readFileSync(SUPABASE, "utf8"));
      if (!isSupabaseWorld(parsed)) throw new Error(`${SUPABASE} isn't the fake Supabase's keys`);
      return parsed;
    },
    save: (world) => writeFileSync(SUPABASE, JSON.stringify(world)),
  },
  effect,
});

const cloudflare = tokensFetch({
  admin: CLOUDFLARE_ADMIN,
  valuePrefix: CLOUDFLARE_PREFIX,
  loseCreated: run.cloudflareTokens?.loseCreated ?? false,
  world: {
    load(): TokenWorld {
      if (!existsSync(CLOUDFLARE))
        return { tokens: run.cloudflareTokens?.tokens ?? [], created: 0 };
      const parsed: unknown = JSON.parse(readFileSync(CLOUDFLARE, "utf8"));
      if (!isTokenWorld(parsed))
        throw new Error(`${CLOUDFLARE} isn't the fake Cloudflare's tokens`);
      return parsed;
    },
    save: (world) => writeFileSync(CLOUDFLARE, JSON.stringify(world)),
  },
  effect,
});

const issuerFetch: Record<string, Fetch> = { cloudflare, neon, openai, resend, supabase };

function isTokenWorld(value: unknown): value is TokenWorld {
  return isRecord(value) && Array.isArray(value.tokens) && typeof value.created === "number";
}

function isSupabaseWorld(value: unknown): value is SupabaseWorld {
  return isRecord(value) && Array.isArray(value.keys) && typeof value.created === "number";
}

function isOpenAIKeys(value: unknown): value is OpenAIKeys {
  return (
    isRecord(value) &&
    typeof value.created === "number" &&
    Array.isArray(value.live) &&
    value.live.every(
      (key: unknown) =>
        isRecord(key) &&
        typeof key.id === "string" &&
        typeof key.value === "string" &&
        isRecord(key.owner),
    )
  );
}

function isNeonWorld(value: unknown): value is NeonWorld {
  return (
    isRecord(value) &&
    isRecord(value.roles) &&
    isRecord(value.operations) &&
    typeof value.made === "number"
  );
}

const real = realDeps();

process.exitCode = await cli(process.argv.slice(2), {
  ...real,
  self: { folder: real.cwd, command: ["keypin"] },
  signIn: () => signedIn().signIn,
  vault: () => vault,
  ghLogin: async () => run.gh,
  workerSignIn: () => fakeSignIn(run.wrangler ? "oauth" : "not-logged-in"),
  githubSecrets: async () =>
    run.githubSecrets
      ? { ok: true, secrets: run.githubSecrets.map((name) => ({ name, updatedAt: null })) }
      : {
          ok: false,
          reason: "gh has no token for an active login; run: gh auth login --hostname github.com",
        },
  organizationSecrets: async () => ({ ok: true, secrets: [] }),
  sshHostname: async () => null,
  workerSecrets: async () => ({ ok: false, reason: "this scenario has no Cloudflare account" }),
  issuer: (spec, admin) => issuer(spec, admin, issuerFetch[spec.kind] ?? resend),
  destination: (target) => {
    const place = placeId(target, destinations);
    const scripted = run.places[place] ?? {};
    return {
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
