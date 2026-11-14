import type { InfisicalRef, KeyRef, OnePasswordRef } from "./contracts";
import { isRecord } from "./record";

const OP = "op://";
const INFISICAL = "infisical://";

export type Reference =
  | Omit<OnePasswordRef, "account">
  | Omit<InfisicalRef, "url" | "organization">;

export const REFERENCE_SCHEMES = [OP, INFISICAL] as const;

export function parseReference(text: string): Reference | string {
  if (/[?#]/.test(text)) return "can't have a query such as ?attribute=";
  if (text.startsWith(OP)) return parseOnePassword(text.slice(OP.length));
  if (text.startsWith(INFISICAL)) return parseInfisical(text.slice(INFISICAL.length));
  return `must start with ${OP} or ${INFISICAL}`;
}

function parseOnePassword(rest: string): Reference | string {
  const parts = rest.split("/");
  if (parts.length < 3 || parts.length > 4 || parts.some((part) => !part.trim())) {
    return `must be ${OP}<vault>/<item>/<field> or ${OP}<vault>/<item>/<section>/<field>`;
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

function parseInfisical(rest: string): Reference | string {
  const parts = rest.split("/");
  if (parts.length < 3 || parts.some((part) => !part.trim())) {
    return `must be ${INFISICAL}<project>/<environment>/<SECRET_NAME>, with any folders before the name`;
  }
  const [project = "", environment = "", ...folders] = parts;
  const name = folders.pop() ?? "";
  return { kind: "infisical", project, environment, path: `/${folders.join("/")}`, name };
}

export function formatReference(ref: Reference): string {
  if (ref.kind === "infisical") {
    const folders = ref.path.split("/").filter(Boolean);
    return `${INFISICAL}${[ref.project, ref.environment, ...folders, ref.name].join("/")}`;
  }
  const parts = [ref.vault, ref.item, ...(ref.section === null ? [] : [ref.section]), ref.field];
  return `${OP}${parts.join("/")}`;
}

export function vaultAccount(ref: KeyRef): string {
  return ref.kind === "1password"
    ? `1Password account ${ref.account}`
    : `Infisical organization ${ref.organization} at ${ref.url}`;
}

export function vaultAccounts(refs: readonly KeyRef[]): string {
  const onePassword = [
    ...new Set(refs.flatMap((ref) => (ref.kind === "1password" ? [ref.account] : []))),
  ];
  const others = refs.filter((ref) => ref.kind !== "1password").map(vaultAccount);
  return [
    ...(onePassword.length ? [`1Password account ${onePassword.join(", ")}`] : []),
    ...new Set(others),
  ].join(" and ");
}

export function describeRef(ref: KeyRef): string {
  return `${formatReference(ref)} (${vaultAccount(ref)})`;
}

const sameName = (a: string | null, b: string | null) =>
  a === b || (a !== null && b !== null && a.toLowerCase() === b.toLowerCase());

export function sameAccount(a: KeyRef, b: KeyRef): boolean {
  return vaultAccount(a) === vaultAccount(b);
}

export function sameItem(a: KeyRef, b: KeyRef): boolean {
  if (!sameAccount(a, b)) return false;
  if (a.kind === "1password" && b.kind === "1password")
    return sameName(a.vault, b.vault) && sameName(a.item, b.item);
  if (a.kind === "infisical" && b.kind === "infisical")
    return (
      a.project === b.project &&
      a.environment === b.environment &&
      a.path === b.path &&
      a.name === b.name
    );
  return false;
}

export function sameField(a: KeyRef, b: KeyRef): boolean {
  if (a.kind === "1password" && b.kind === "1password")
    return sameName(a.section, b.section) && sameName(a.field, b.field);
  return a.kind === b.kind;
}

export function sameRef(a: KeyRef, b: KeyRef): boolean {
  return sameItem(a, b) && sameField(a, b);
}

export function storedRefWithPasswordDefault(value: unknown): KeyRef | null {
  if (!isRecord(value)) return null;
  if (value.kind === "infisical") {
    const { url, organization, project, environment, path, name } = value;
    if (
      typeof url !== "string" ||
      typeof organization !== "string" ||
      typeof project !== "string" ||
      typeof environment !== "string" ||
      typeof path !== "string" ||
      typeof name !== "string"
    )
      return null;
    return { kind: "infisical", url, organization, project, environment, path, name };
  }
  if (value.kind !== "1password") return null;
  const { account, vault, item, section = null, field = "password" } = value;
  if (typeof account !== "string" || typeof vault !== "string" || typeof item !== "string")
    return null;
  if (typeof field !== "string" || (section !== null && typeof section !== "string")) return null;
  return { kind: "1password", account, vault, item, section, field };
}
