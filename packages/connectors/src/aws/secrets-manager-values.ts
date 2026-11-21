import { isRecord, WriteRefused } from "@keypin/core";
import { describe as describeRef, type SecretsManagerRef as Ref } from "./reference";

export type Json = Record<string, unknown>;

export type Fail = (message: string) => Error;
export const plain: Fail = (message) => new Error(message);
export const refused: Fail = (message) => new WriteRefused(message);

export function fieldOf(ref: Ref, value: string, fail: Fail): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed))
    throw fail(
      `${describeRef(ref)}: the secret isn't a JSON object, so it has no key ${ref.field}`,
    );
  const found = parsed[ref.field ?? ""];
  if (found === undefined)
    throw fail(`${describeRef(ref)}: the secret's JSON has no key ${ref.field}`);
  if (typeof found !== "string")
    throw fail(`${describeRef(ref)}: the JSON key ${ref.field} holds a ${typeof found}, not text`);
  return found;
}

export function tagsOf(entry: Json): { Key: string; Value: string }[] {
  return Array.isArray(entry.Tags)
    ? entry.Tags.flatMap((pair) =>
        isRecord(pair) && typeof pair.Key === "string"
          ? [{ Key: pair.Key, Value: typeof pair.Value === "string" ? pair.Value : "" }]
          : [],
      )
    : [];
}

export function dateOf(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;
}
