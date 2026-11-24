import { isRecord } from "@keypin/core";

export type OnePasswordRef = {
  kind: "1password";
  account: string;
  vault: string;
  item: string;
  section: string | null;
  field: string;
  fallback?: string;
};

export type OnePasswordReference = Omit<OnePasswordRef, "account">;

export type OnePasswordScope = { kind: "1password"; account: string; vault: string };

export const SCHEME = "op://";

export function parse(rest: string): OnePasswordReference | string {
  const parts = rest.split("/");
  if (parts.length < 3 || parts.length > 4 || parts.some((part) => !part.trim())) {
    return `must be ${SCHEME}<vault>/<item>/<field> or ${SCHEME}<vault>/<item>/<section>/<field>`;
  }
  const [vault = "", item = "", ...fields] = parts;
  return {
    kind: "1password",
    vault,
    item,
    section: fields.length === 2 ? (fields[0] ?? null) : null,
    field: fields.at(-1) ?? "",
  };
}

const REFERABLE = /^[A-Za-z0-9 ._-]+$/;

export function format(ref: OnePasswordReference): string {
  const parts = [ref.vault, ref.item, ...(ref.section === null ? [] : [ref.section]), ref.field];
  if (parts.every((part) => REFERABLE.test(part))) return `${SCHEME}${parts.join("/")}`;
  return parts.join(" › ");
}

export function account(ref: Pick<OnePasswordRef, "account">): string {
  return ref.account ? `1Password account ${ref.account}` : "1Password's default account";
}

export function accountName(account: string): string {
  return account ? `1Password account "${account}"` : "1Password's default account";
}

export const sameName = (a: string | null, b: string | null) =>
  a === b || (a !== null && b !== null && a.toLowerCase() === b.toLowerCase());

export function decode(value: unknown): OnePasswordRef | null {
  if (!isRecord(value) || value.kind !== "1password") return null;
  const { account, vault, item, section = null, field = "password", fallback } = value;
  if (typeof account !== "string" || typeof vault !== "string" || typeof item !== "string")
    return null;
  if (typeof field !== "string" || (section !== null && typeof section !== "string")) return null;
  if (fallback !== undefined && typeof fallback !== "string") return null;
  const ref: OnePasswordRef = { kind: "1password", account, vault, item, section, field };
  return fallback === undefined ? ref : { ...ref, fallback };
}

export function decodeScope(value: unknown): OnePasswordScope | null {
  if (!isRecord(value) || value.kind !== "1password") return null;
  const { account, vault } = value;
  return typeof account === "string" && typeof vault === "string"
    ? { kind: "1password", account, vault }
    : null;
}
