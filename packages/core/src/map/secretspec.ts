import { parse as parseToml } from "smol-toml";
import type { Environment, KeyRef } from "../contracts";
import type { VaultRules } from "../login";
import { isRecord } from "../record";
import { TOOL_FIELDS } from "./key";
import { isEnvironmentName, VARIABLE_NAME } from "./keys-map";
import { PLACEHOLDER, type Table } from "./table";

export const SECRETSPEC_FILE = "secretspec.toml";

const DEFAULT = "default";
const SCHEME = /^([a-z][a-z0-9.-]*)(?:\+[a-z0-9.-]+)?:\/\//i;

export interface Declared {
  readonly profile: Environment;
  readonly name: string;
  readonly ref: KeyRef;
}

export interface Profiles {
  readonly project: string;
  readonly environments: readonly Environment[];
  readonly declared: readonly Declared[];
  readonly derived: ReadonlySet<string>;
  readonly unplaced: ReadonlySet<string>;
}

type Fail = (where: string, message: string) => void;

const table = (value: unknown): Table => (isRecord(value) ? value : {});

function firstChain(
  levels: readonly (readonly [string, unknown])[],
): string[] | { invalid: string } | null {
  for (const [name, value] of levels) {
    if (value === undefined) continue;
    return Array.isArray(value) && value.length && value.every((each) => typeof each === "string")
      ? value
      : { invalid: name };
  }
  return null;
}

export function readProfiles(
  data: Table,
  vaults: readonly VaultRules[],
  fail: Fail,
): Profiles | undefined {
  const project = table(data.project);
  const name = project.name;
  if (!isRecord(data.project) || typeof name !== "string" || !name.trim()) {
    fail("", `[project] needs name, such as name = "web"`);
    return undefined;
  }
  if (project.extends !== undefined) {
    fail("[project]: ", `keypin doesn't read extends yet; declare the secrets in this file`);
    return undefined;
  }
  if (!isRecord(data.profiles) || !Object.keys(data.profiles).length) {
    fail("", `needs a profile, such as [profiles.default]`);
    return undefined;
  }
  const profiles = data.profiles;
  const environments: Environment[] = [];
  for (const [profile, raw] of Object.entries(profiles)) {
    if (!isEnvironmentName(profile))
      fail(
        `[profiles.${profile}]: `,
        "keypin needs a profile name that starts with a lowercase letter and uses only lowercase letters, digits and dashes",
      );
    else if (!isRecord(raw)) fail(`[profiles.${profile}]: `, "must be a table");
    else environments.push(profile);
  }

  const base = table(profiles[DEFAULT]);
  const declared: Declared[] = [];
  const derived = new Set<string>();
  const unplaced = new Set<string>();
  const reported = new Set<string>();
  for (const profile of environments) {
    const own = table(profiles[profile]);
    const defaults = table(own.defaults);
    const inherits = profile !== DEFAULT && defaults.inherit !== false;
    const names = [...new Set([...(inherits ? Object.keys(base) : []), ...Object.keys(own)])];
    for (const key of names.filter((each) => each !== "defaults")) {
      const where = `[profiles.${profile}] ${key}: `;
      const current = own[key];
      const inherited = inherits ? base[key] : undefined;
      if (!VARIABLE_NAME.test(key)) {
        fail(where, "a secret's name uses letters, digits and _, not starting with a digit");
        continue;
      }
      if (
        (current !== undefined && !isRecord(current)) ||
        (current === undefined && !isRecord(inherited))
      ) {
        fail(where, `must be a table, such as { description = "..." }`);
        continue;
      }
      const mine = table(current);
      const theirs = table(inherited);
      for (const setting of TOOL_FIELDS.filter((each) => mine[each] !== undefined))
        fail(
          where,
          `"${setting}" is a keypin setting, and secretspec drops it from a secret; move it to [tool.keypin.${profile}.${key}]`,
        );
      const field = (name: string): unknown => mine[name] ?? theirs[name];
      if (field("composed") !== undefined || field("from") !== undefined) {
        derived.add(`${profile} ${key}`);
        continue;
      }
      const providers = firstChain([
        ["providers", field("providers")],
        [`[profiles.${profile}.defaults] providers`, defaults.providers],
        ["[defaults] providers", table(data.defaults).providers],
      ]);
      if (providers && "invalid" in providers) {
        fail(where, `${providers.invalid} must be a list of provider names, such as ["acme"]`);
        unplaced.add(`${profile} ${key}`);
        continue;
      }
      const refs = mine.ref !== undefined || mine.refs !== undefined ? mine : theirs;
      const ref = locate(
        { data, project: name, profile, key, providers, refs },
        vaults,
        (problem) => {
          const once = `${key} ${problem}`;
          if (current === undefined && reported.has(once)) return;
          reported.add(once);
          fail(where, problem);
        },
      );
      if (ref) declared.push({ profile, name: key, ref });
      else unplaced.add(`${profile} ${key}`);
    }
  }
  return { project: name, environments, declared, derived, unplaced };
}

interface Located {
  readonly data: Table;
  readonly project: string;
  readonly profile: Environment;
  readonly key: string;
  readonly providers: readonly string[] | null;
  readonly refs: Table;
}

function locate(
  { data, project, profile, key, providers, refs }: Located,
  vaults: readonly VaultRules[],
  fail: (message: string) => void,
): KeyRef | undefined {
  const [first] = providers ?? [];
  if (first === undefined) {
    fail(
      `names no provider in ${SECRETSPEC_FILE}, so CI and the console can't find its vault; add providers = ["..."] to it, or set [defaults] providers`,
    );
    return undefined;
  }
  const named = provider(table(data.providers), first);
  if (named === null) {
    fail(
      `provider "${first}" isn't under [providers] in ${SECRETSPEC_FILE}, so CI and the console can't find its vault; define it there`,
    );
    return undefined;
  }
  const { uri } = named;
  if (PLACEHOLDER.test(uri)) {
    const subject = uri === first ? `uses ${uri}` : `provider "${first}" is ${uri}`;
    fail(`${subject}, with a <...> placeholder: replace each <...> with the real value`);
    return undefined;
  }
  const scheme = SCHEME.exec(uri)?.[1]?.toLowerCase();
  const vault = vaults.find((each) => each.secretspec?.provider === scheme);
  const read = vaults.flatMap((each) => (each.secretspec?.locate ? [each.name] : []));
  if (!vault?.secretspec) {
    const names = read.length > 1 ? `${read.slice(0, -1).join(", ")} and ${read.at(-1)}` : read[0];
    fail(`uses ${uri}, and keypin reads only ${names} from ${SECRETSPEC_FILE}`);
    return undefined;
  }
  if (!vault.secretspec.locate) {
    fail(`uses ${uri}; keypin doesn't read ${vault.name} from ${SECRETSPEC_FILE} yet`);
    return undefined;
  }
  const ref = coordinates(refs);
  if (typeof ref === "string") {
    fail(ref);
    return undefined;
  }
  const holder = Object.entries(ref ?? {}).find(
    ([, value]) => typeof value === "string" && PLACEHOLDER.test(value),
  );
  if (holder) {
    fail(`field "ref" has a <...> placeholder in ${holder[0]}: replace it with the real value`);
    return undefined;
  }
  if (ref === null && named.template) {
    fail(
      `provider "${first}" has a ref template, and keypin doesn't read ref templates yet; give the secret its own ref`,
    );
    return undefined;
  }
  const found = vault.secretspec.locate({ uri, project, profile, key, ref });
  if (typeof found === "string") {
    fail(found);
    return undefined;
  }
  return found;
}

function provider(providers: Table, entry: string): { uri: string; template: boolean } | null {
  const alias = providers[entry];
  if (typeof alias === "string") return { uri: alias, template: false };
  if (isRecord(alias) && typeof alias.uri === "string")
    return { uri: alias.uri, template: alias.ref !== undefined };
  return entry.includes("://") ? { uri: entry, template: false } : null;
}

function coordinates(secret: Table): Table | null | string {
  if (secret.refs !== undefined)
    return `keypin doesn't read refs yet; give the secret one ref = { item = "..." }`;
  if (secret.ref === undefined) return null;
  return isRecord(secret.ref)
    ? secret.ref
    : `field "ref" must be a table, such as { item = "..." }`;
}

export function projectDefaults(text: string): { declared: boolean; uri: string | null } {
  let data: Table;
  try {
    data = parseToml(text);
  } catch {
    return { declared: false, uri: null };
  }
  if (!isRecord(data.defaults)) return { declared: false, uri: null };
  const providers = firstChain([["[defaults] providers", data.defaults.providers]]);
  const [first] = Array.isArray(providers) ? providers : [];
  return {
    declared: true,
    uri: first === undefined ? null : (provider(table(data.providers), first)?.uri ?? null),
  };
}
