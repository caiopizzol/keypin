import { describe as describeRef, format, type InfisicalRef } from "./reference";
import type { Json } from "./response";

export function fromElsewhere(ref: InfisicalRef, how: string, sources: readonly string[]): string {
  const [only] = sources;
  const source = sources.length === 1 && only ? only : "the source secret";
  return `${describeRef(ref)}: the secret ${how} ${sources.join(" and ")}, so a new key saved here would leave that secret, and everything that uses it, with the old key; point secretspec.toml at ${source} instead`;
}

export function importSource(ref: InfisicalRef, secret: Json): string {
  const { environment, secretPath } = secret;
  if (typeof environment !== "string" || typeof secretPath !== "string")
    return "another environment or folder";
  return format({ ...ref, environment, path: secretPath });
}

const REFERENCE = /\$\{([a-zA-Z0-9-_.@]+(?: +[a-zA-Z0-9-_@]+)*)\}/g;

export function referencedBy(ref: InfisicalRef, raw: string): string[] {
  return [
    ...new Set([...raw.matchAll(REFERENCE)].map(([, inner = ""]) => referenceTo(ref, inner))),
  ];
}

function referenceTo(ref: InfisicalRef, inner: string): string {
  const parts = inner.split(".");
  const project = parts[0]?.startsWith("@") ? parts.shift()?.slice(1) : undefined;
  const name = parts.pop() ?? "";
  const [environment, ...folders] = parts;
  const place = project === undefined ? ref : { ...ref, project };
  if (environment === undefined) return format({ ...place, name });
  return format({ ...place, environment, path: `/${folders.join("/")}`, name });
}
