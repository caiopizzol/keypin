import type { KeyRef } from "./contracts";
import { isRecord } from "./record";

const SCHEME = "op://";

export type Reference = Omit<KeyRef, "kind" | "account">;

export function parseReference(text: string): Reference | string {
  if (!text.startsWith(SCHEME)) return `must start with ${SCHEME}`;
  if (/[?#]/.test(text)) return "can't have a query such as ?attribute=";
  const parts = text.slice(SCHEME.length).split("/");
  if (parts.length < 3 || parts.length > 4 || parts.some((part) => !part.trim())) {
    return `must be ${SCHEME}<vault>/<item>/<field> or ${SCHEME}<vault>/<item>/<section>/<field>`;
  }
  const [vault = "", item = "", ...rest] = parts;
  return {
    vault,
    item,
    section: rest.length === 2 ? (rest[0] ?? null) : null,
    field: rest.at(-1) ?? "",
  };
}

export function formatReference(ref: Reference): string {
  const parts = [ref.vault, ref.item, ...(ref.section === null ? [] : [ref.section]), ref.field];
  return `${SCHEME}${parts.join("/")}`;
}

const sameName = (a: string | null, b: string | null) =>
  a === b || (a !== null && b !== null && a.toLowerCase() === b.toLowerCase());

export function sameItem(a: KeyRef, b: KeyRef): boolean {
  return (
    a.kind === b.kind &&
    a.account === b.account &&
    sameName(a.vault, b.vault) &&
    sameName(a.item, b.item)
  );
}

export function sameField(a: KeyRef, b: KeyRef): boolean {
  return sameName(a.section, b.section) && sameName(a.field, b.field);
}

export function sameRef(a: KeyRef, b: KeyRef): boolean {
  return sameItem(a, b) && sameField(a, b);
}

export function storedRefWithPasswordDefault(value: unknown): KeyRef | null {
  if (!isRecord(value) || value.kind !== "1password") return null;
  const { account, vault, item, section = null, field = "password" } = value;
  if (typeof account !== "string" || typeof vault !== "string" || typeof item !== "string")
    return null;
  if (typeof field !== "string" || (section !== null && typeof section !== "string")) return null;
  return { kind: "1password", account, vault, item, section, field };
}
