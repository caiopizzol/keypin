import type { Environment, KeyRef } from "../contracts";
import { checkId, type DestinationRules, placeId, type PublishTarget } from "../destination";
import { idKeyOf, type IssuerRules, type IssuerReader, type IssuerSpec } from "../issuer";
import type { VaultRules } from "../login";
import { pullKindOf, type PullKinds, pullPlace, type PullReader } from "../pull";
import { isRecord } from "../record";
import { parseReference, referenceSchemes, sameItem } from "../reference";
import { periodDays } from "../days";
import { type EnvEntry, type KeyEntry, type VaultPins, VARIABLE_NAME } from "./keys-map";
import {
  type Table,
  PLACEHOLDER,
  tableReader,
  unknownFields,
  requiredString,
  optionalString,
} from "./table";

const KEY_FIELDS: readonly string[] = ["rotate_every"];

const REMOVED_KEY_FIELDS: readonly string[] = ["owner", "consumers"];

export const OLD_FORMAT = "see docs/configuration.md for the current format";

export interface MapContext {
  pins: VaultPins;
  environments: readonly Environment[];
  kinds: readonly DestinationRules[];
  issuers: readonly IssuerRules[];
  vaults: readonly VaultRules[];
  pulls: PullKinds;
}

export function validateKey(
  id: string,
  raw: unknown,
  context: MapContext,
  fail: (where: string, message: string) => void,
): KeyEntry | undefined {
  const environmentNames = context.environments;
  let failures = 0;
  const err = (where: string, message: string) => {
    failures++;
    fail(where, message);
  };
  if (!VARIABLE_NAME.test(id))
    err(
      "",
      "the table name is the variable your program reads: letters, digits and _, not starting with a digit",
    );
  if (!isRecord(raw)) {
    err("", "must be a table");
    return undefined;
  }
  unknownFields(raw, [...KEY_FIELDS, ...environmentNames], (field) =>
    err(
      "",
      field === "env"
        ? `field "env" is from keypin 0.4; name the table after the variable, such as [keys.API_TOKEN] (${OLD_FORMAT})`
        : REMOVED_KEY_FIELDS.includes(field)
          ? `field "${field}" is no longer used; delete it`
          : `unknown field "${field}"; environments are ${environmentNames.map((n) => `"${n}"`).join(", ")}`,
    ),
  );
  const rotateEvery = rotation(
    optionalString(raw, "rotate_every", (m) => err("", m)),
    (m) => err("", m),
  );

  const environments: Record<Environment, EnvEntry> = {};
  Reflect.setPrototypeOf(environments, null);
  const declared = environmentNames.filter((name) => Object.hasOwn(raw, name));
  for (const name of declared) {
    const entry = validateEnv(raw[name], context, (m) => err(` ${name}`, m));
    if (entry) environments[name] = entry;
  }
  for (const [name, entry] of Object.entries(environments)) {
    const refused = new Set<string>();
    entry.publish.forEach((target, index) => {
      const why = context.kinds.find((k) => k.kind === target.to)?.refuses?.(id);
      if (why === undefined || refused.has(target.to)) return;
      refused.add(target.to);
      err(` ${name}`, `publish[${index}]: ${target.to} can't take this key, because ${why}`);
    });
    const issuer = entry.issuer?.kind;
    const why = context.issuers.find((k) => k.kind === issuer)?.refuses?.(id);
    if (why !== undefined)
      err(` ${name}`, `issuer: ${issuer} can't rotate this key, because ${why}`);
  }
  if (!declared.length) {
    err("", `needs at least one of ${environmentNames.map((n) => `"${n}"`).join(", ")}`);
  }

  if (failures) return undefined;
  return { name: id, rotateEvery, environments };
}

function rotation(
  text: string | undefined,
  fail: (message: string) => void,
): KeyEntry["rotateEvery"] {
  if (text === undefined) return null;
  const days = periodDays(text);
  if (days !== undefined) return { text, days };
  fail(`field "rotate_every" must be <n>d, <n>w, <n>m or never`);
  return null;
}

function validateEnv(
  given: unknown,
  context: MapContext,
  fail: (message: string) => void,
): EnvEntry | undefined {
  const { kinds } = context;
  const raw = typeof given === "string" ? { from: given } : given;
  if (!isRecord(raw)) {
    fail(`must be an ${referenceSchemes(context.vaults)} reference, or a table with "from"`);
    return undefined;
  }
  let failed = false;
  const err = (message: string) => {
    failed = true;
    fail(message);
  };
  unknownFields(raw, ["from", "publish", "pull", "issuer"], (field) =>
    err(
      field === "vault" || field === "item"
        ? `"vault" and "item" are from keypin 0.4; use from = "op://<vault>/<item>/<field>" (${OLD_FORMAT})`
        : field === "rotate" || field === "issue"
          ? `the "${field}" section is from an older keypin; delete it. To let keypin rotate the key, add an "issuer" table instead (${OLD_FORMAT})`
          : `unknown field "${field}"`,
    ),
  );
  const ref = reference(raw, "from", context, err);

  const publish: PublishTarget[] = [];
  const publishedAt: number[] = [];
  const firstAt = new Map<string, number>();
  if (raw.publish !== undefined) {
    if (!Array.isArray(raw.publish)) err(`field "publish" must be a list`);
    else {
      raw.publish.forEach((t: unknown, i: number) => {
        const target = destination(t, kinds, (m) => err(`publish[${i}]: ${m}`));
        if (!target) return;
        const place = placeId(target, kinds);
        const same = firstAt.get(place);
        if (same !== undefined) err(`publish[${i}]: the same destination as publish[${same}]`);
        else {
          firstAt.set(place, i);
          publish.push(target);
          publishedAt.push(i);
        }
      });
    }
  }
  const pull = readers(raw.pull, publish, publishedAt, context, err);
  const issuer =
    raw.issuer === undefined || !ref
      ? undefined
      : validateIssuer(raw.issuer, ref, context, (m) => err(`issuer: ${m}`));
  if (failed || !ref) return undefined;
  if (!issuer) return { ref, publish, pull };
  const idKey = idKeyOf(context.issuers, issuer);
  return idKey === null ? { ref, publish, pull, issuer } : { ref, publish, pull, issuer, idKey };
}

function readers(
  raw: unknown,
  publish: readonly PublishTarget[],
  publishedAt: readonly number[],
  { kinds, pulls }: MapContext,
  fail: (message: string) => void,
): PullReader[] {
  const found: PullReader[] = [];
  if (raw === undefined) return found;
  if (!Array.isArray(raw)) {
    fail(`field "pull" must be a list`);
    return found;
  }
  const firstAt = new Map<string, number>();
  raw.forEach((each: unknown, i: number) => {
    const reader = pullReader(each, pulls, (m) => fail(`pull[${i}]: ${m}`));
    if (!reader) return;
    const place = pullPlace(reader, pulls);
    const same = firstAt.get(place);
    const pushed = publish.findIndex((target) => checkId(target, kinds) === place);
    if (same !== undefined) fail(`pull[${i}]: the same place as pull[${same}]`);
    else if (pushed !== -1)
      fail(
        `pull[${i}]: publish[${publishedAt[pushed]}] also writes the key to ${pullKindOf(pulls, reader.by).describe(reader)}; keep one of them. To pull it instead, delete that publish entry, and delete the copy publish wrote there`,
      );
    else {
      firstAt.set(place, i);
      found.push(reader);
    }
  });
  return found;
}

function pullReader(
  raw: unknown,
  pulls: PullKinds,
  fail: (message: string) => void,
): PullReader | undefined {
  if (!isRecord(raw)) {
    fail("must be a table");
    return undefined;
  }
  const by = requiredString(raw, "by", fail);
  if (by === undefined) return undefined;
  const kind = pulls.find((k) => k.kind === by);
  if (!kind) {
    fail(
      `field "by" must be one of: ${pulls
        .map((k) => k.kind)
        .toSorted()
        .join(", ")}`,
    );
    return undefined;
  }
  let failed = false;
  const err = (message: string) => {
    failed = true;
    fail(message);
  };
  const reader = kind.parse(tableReader(raw, ["by"], kind.kind, err));
  if (reader === undefined && !failed) err(`the "${kind.kind}" pull couldn't read this table`);
  return failed ? undefined : reader;
}

function validateIssuer(
  raw: unknown,
  own: KeyRef,
  context: MapContext,
  fail: (message: string) => void,
): IssuerSpec | undefined {
  const { issuers, vaults } = context;
  if (!isRecord(raw)) {
    fail("must be a table");
    return undefined;
  }
  let failed = false;
  const err = (message: string) => {
    failed = true;
    fail(message);
  };
  const kind = requiredString(raw, "kind", err);
  if (kind === undefined) return undefined;
  const found = issuers.find((k) => k.kind === kind);
  if (!found) {
    err(`field "kind" must be one of: ${issuers.map((k) => k.kind).join(", ")}`);
    return undefined;
  }
  const reader: IssuerReader = {
    ...tableReader(raw, found.admin === false ? ["kind"] : ["kind", "admin"], kind, err),
    admin() {
      const admin = reference(raw, "admin", context, err);
      if (!admin || !sameItem(admin, own, vaults)) return admin;
      err(`field "admin" names the key's own item; the admin key needs its own item`);
      return undefined;
    },
    idKey() {
      const name = requiredString(raw, "key_id", err);
      if (name === undefined || VARIABLE_NAME.test(name)) return name;
      err(`field "key_id" must name a key in this map, such as "API_KEY_ID"`);
      return undefined;
    },
  };
  const spec = found.parse(reader);
  if (spec === undefined && !failed) err(`the "${kind}" issuer couldn't read this table`);
  return failed ? undefined : spec;
}

function reference(
  table: Table,
  field: string,
  { pins, vaults }: MapContext,
  fail: (message: string) => void,
): KeyRef | undefined {
  const text = requiredString(table, field, fail);
  if (text === undefined) return undefined;
  const parsed = parseReference(text, vaults);
  if (typeof parsed === "string") {
    fail(`field "${field}" ${parsed}`);
    return undefined;
  }
  const { vault, reference: found } = parsed;
  const parts = Object.entries(found)
    .filter(
      ([part, value]) => part !== "kind" && typeof value === "string" && PLACEHOLDER.test(value),
    )
    .map(([part]) => part);
  if (parts.length) {
    fail(
      `field "${field}" has a <...> placeholder for its ${parts.join(" and ")}: replace it with ${vault.placeholder}`,
    );
    return undefined;
  }
  const pin = pins[vault.kind];
  if (pin === undefined) {
    fail(`field "${field}" ${vault.needsPin}`);
    return undefined;
  }
  return vault.pinned(found, pin);
}

function destination(
  raw: unknown,
  kinds: readonly DestinationRules[],
  fail: (message: string) => void,
): PublishTarget | undefined {
  if (typeof raw === "string") {
    fail(
      `names a shared target, which is no longer supported; write the destination inline, such as { to = "github-actions", repo = "owner/name" } (${OLD_FORMAT})`,
    );
    return undefined;
  }
  if (!isRecord(raw)) {
    fail("must be a table");
    return undefined;
  }
  const to = requiredString(raw, "to", fail);
  if (to === undefined) return undefined;
  let failed = false;
  const err = (message: string) => {
    failed = true;
    fail(message);
  };
  const kind = kinds.find((k) => k.kind === to);
  if (!kind) {
    err(
      `field "to" must be one of: ${kinds
        .map((k) => k.kind)
        .toSorted()
        .join(", ")}`,
    );
    return undefined;
  }
  const target = kind.parse(tableReader(raw, ["to"], kind.kind, err));
  if (target === undefined && !failed)
    err(`the "${kind.kind}" destination couldn't read this table`);
  return failed ? undefined : target;
}
