import type { Environment, KeyRef } from "../contracts";
import { type DestinationRules, placeId, type PublishTarget } from "../destination";
import { idKeyOf, type IssuerRules, type IssuerReader, type IssuerSpec } from "../issuer";
import type { VaultRules } from "../login";
import { isRecord } from "../record";
import { parseReference, sameItem, vaultName } from "../reference";
import { periodDays } from "../days";
import { type EnvEntry, type KeyEntry, VARIABLE_NAME } from "./keys-map";
import {
  type Table,
  PLACEHOLDER,
  tableReader,
  unknownFields,
  requiredString,
  optionalString,
} from "./table";

export const TOOL_FIELDS: readonly string[] = ["rotate_every", "publish", "issuer", "name"];
const KEY_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface MapContext {
  environments: readonly Environment[];
  kinds: readonly DestinationRules[];
  issuers: readonly IssuerRules[];
  vaults: readonly VaultRules[];
}

interface ToolEntry {
  entry: EnvEntry;
  rotateEvery: string | undefined;
}

export function rotation(
  text: string | undefined,
  fail: (message: string) => void,
): KeyEntry["rotateEvery"] {
  if (text === undefined) return null;
  const days = periodDays(text);
  if (days !== undefined) return { text, days };
  fail(`field "rotate_every" must be <n>d, <n>w, <n>m or never`);
  return null;
}

export function validateTool(
  id: string,
  raw: unknown,
  ref: KeyRef,
  context: MapContext,
  fail: (message: string) => void,
): ToolEntry | undefined {
  const { kinds } = context;
  if (!isRecord(raw)) {
    fail(`must be a table with ${TOOL_FIELDS.map((f) => `"${f}"`).join(", ")}`);
    return undefined;
  }
  let failed = false;
  const err = (message: string) => {
    failed = true;
    fail(message);
  };
  unknownFields(raw, TOOL_FIELDS, (field) => err(`unknown field "${field}"`));
  const rotateEvery = optionalString(raw, "rotate_every", err);
  rotation(rotateEvery, err);

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
  const refused = new Set<string>();
  publish.forEach((target, index) => {
    const why = kinds.find((k) => k.kind === target.to)?.refuses?.(id);
    if (why === undefined || refused.has(target.to)) return;
    refused.add(target.to);
    err(`publish[${publishedAt[index]}]: ${target.to} can't take this key, because ${why}`);
  });
  const issuer =
    raw.issuer === undefined
      ? undefined
      : validateIssuer(raw.issuer, ref, context, (m) => err(`issuer: ${m}`));
  const rules = context.issuers.find((k) => k.kind === issuer?.kind);
  const why = rules?.refuses?.(id);
  if (issuer && why !== undefined)
    err(`issuer: ${issuer.kind} can't rotate this key, because ${why}`);
  const name = optionalString(raw, "name", err);
  if (name !== undefined && !KEY_NAME.test(name))
    err(`field "name" uses lowercase letters, digits and -, such as "acme-web-mail"`);
  else if (name !== undefined && raw.issuer === undefined)
    err(`field "name" names the key at its issuer; add an issuer, or remove the name`);
  else if (name !== undefined && rules?.names === false)
    err(`field "name": ${rules.kind} doesn't name the keys it makes; remove the name`);
  if (failed) return undefined;
  if (!issuer) return { entry: { ref, publish }, rotateEvery };
  const idKey = idKeyOf(context.issuers, issuer);
  return {
    entry: {
      ref,
      publish,
      issuer,
      ...(idKey === null ? {} : { idKey }),
      ...(name === undefined ? {} : { name }),
    },
    rotateEvery,
  };
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
      const admin = adminReference(raw, own, context, err);
      if (!admin || !sameItem(admin, own, vaults)) return admin;
      err(`field "admin" names the key's own item; the admin key needs its own item`);
      return undefined;
    },
    idKey() {
      const name = requiredString(raw, "key_id", err);
      if (name === undefined || VARIABLE_NAME.test(name)) return name;
      err(`field "key_id" must name a key in secretspec.toml, such as "API_KEY_ID"`);
      return undefined;
    },
  };
  const spec = found.parse(reader);
  if (spec === undefined && !failed) err(`the "${kind}" issuer couldn't read this table`);
  return failed ? undefined : spec;
}

function adminReference(
  table: Table,
  own: KeyRef,
  { vaults }: MapContext,
  fail: (message: string) => void,
): KeyRef | undefined {
  const text = requiredString(table, "admin", fail);
  if (text === undefined) return undefined;
  const parsed = parseReference(text, vaults);
  if (typeof parsed === "string") {
    fail(`field "admin" ${parsed}`);
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
      `field "admin" has a <...> placeholder for its ${parts.join(" and ")}: replace it with ${vault.placeholder}`,
    );
    return undefined;
  }
  if (vault.kind !== own.kind) {
    fail(
      `field "admin" is in ${vault.name}, and the key is in ${vaultName(own, vaults)}; keypin reads the admin key from the key's own vault account`,
    );
    return undefined;
  }
  return vault.pinned(found, own);
}

function destination(
  raw: unknown,
  kinds: readonly DestinationRules[],
  fail: (message: string) => void,
): PublishTarget | undefined {
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
