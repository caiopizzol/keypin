import { isRecord, type TableReader } from "@keypin/core";

export type OnePasswordRef = {
  kind: "1password";
  account: string;
  vault: string;
  item: string;
  section: string | null;
  field: string;
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

export function format(ref: OnePasswordReference): string {
  const parts = [ref.vault, ref.item, ...(ref.section === null ? [] : [ref.section]), ref.field];
  return `${SCHEME}${parts.join("/")}`;
}

export function account(ref: Pick<OnePasswordRef, "account">): string {
  return `1Password account ${ref.account}`;
}

export function readPin(read: TableReader): string | undefined {
  read.only(["account"]);
  const pinned = read.required("account");
  read.filledIn(
    pinned,
    "account",
    "your 1Password account's sign-in address (such as my.1password.com, at the top left of the 1Password app) or its account ID",
  );
  return pinned;
}

export const sameName = (a: string | null, b: string | null) =>
  a === b || (a !== null && b !== null && a.toLowerCase() === b.toLowerCase());

export function decode(value: unknown): OnePasswordRef | null {
  if (!isRecord(value) || value.kind !== "1password") return null;
  const { account, vault, item, section = null, field = "password" } = value;
  if (typeof account !== "string" || typeof vault !== "string" || typeof item !== "string")
    return null;
  if (typeof field !== "string" || (section !== null && typeof section !== "string")) return null;
  return { kind: "1password", account, vault, item, section, field };
}

export function decodeScope(value: unknown): OnePasswordScope | null {
  if (!isRecord(value) || value.kind !== "1password") return null;
  const { account, vault } = value;
  return typeof account === "string" && typeof vault === "string"
    ? { kind: "1password", account, vault }
    : null;
}
