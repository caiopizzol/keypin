import { isRecord, type KeyRef, type VaultScope } from "@keypin/core";
import {
  decode,
  decodeScope,
  type DopplerRef,
  type DopplerScope as Scope,
  format,
} from "./reference";

export function own(ref: KeyRef): DopplerRef {
  const mine = decode(ref);
  if (!mine)
    throw new Error(`keypin's Doppler vault can't read this reference, which is for ${ref.kind}`);
  return mine;
}

export function ownScope(scope: VaultScope): Scope {
  const mine = decodeScope(scope);
  if (!mine) throw new Error(`keypin's Doppler vault can't list ${scope.kind} items`);
  return mine;
}

export function scopeOf(ref: DopplerRef): Scope {
  return { kind: ref.kind, workplace: ref.workplace, project: ref.project, config: ref.config };
}

export function isConfigName(entry: unknown): entry is { project: string; config: string } {
  return isRecord(entry) && typeof entry.project === "string" && typeof entry.config === "string";
}

export function sourceOf(sources: string[]): string {
  const [only] = sources;
  return sources.length === 1 && only ? only : "the source secret";
}

export function idsOf(ref: DopplerRef) {
  return { vault: `${ref.project}/${ref.config}`, item: ref.name };
}

const REFERENCE = /\$\{([^}]+)\}/g;
const QUOTED = /^(?:(.*)\.)?"([^"]*)"$/;

export function referencedBy(ref: DopplerRef, raw: string): string[] {
  return [
    ...new Set([...raw.matchAll(REFERENCE)].map(([, inner = ""]) => referenceTo(ref, inner))),
  ];
}

function referenceTo(ref: DopplerRef, inner: string): string {
  const quoted = QUOTED.exec(inner);
  const parts = quoted ? (quoted[1]?.split(".") ?? []) : inner.split(".");
  const name = quoted ? (quoted[2] ?? "") : (parts.pop() ?? "");
  const config = parts.pop() ?? ref.config;
  const project = parts.pop() ?? ref.project;
  return format({ ...ref, project, config, name });
}
