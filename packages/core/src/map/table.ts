import type { TableReader } from "../destination";

export type Table = Record<string, unknown>;

export const PLACEHOLDER = /<[^<>]*>/;

function filledIn(
  value: string | undefined,
  field: string,
  what: string,
  fail: (message: string) => void,
): string | undefined {
  if (value === undefined || !PLACEHOLDER.test(value)) return value;
  fail(`field "${field}" is a <...> placeholder: replace it with ${what}`);
  return undefined;
}

export function tableReader(
  table: Table,
  fixed: readonly string[],
  kind: string,
  fail: (m: string) => void,
): TableReader {
  return {
    required: (field) => requiredString(table, field, fail),
    optional: (field) => optionalString(table, field, fail),
    list: (field) => stringList(table, field, fail),
    filledIn: (value, field, what) => filledIn(value, field, what, fail),
    only: (fields, outdated = {}) =>
      unknownFields(table, [...fixed, ...fields], (field) =>
        fail(
          Object.hasOwn(outdated, field)
            ? (outdated[field] ?? "")
            : `unknown field "${field}" for ${kind}`,
        ),
      ),
    fail,
  };
}

export function unknownFields(
  table: Table,
  known: readonly string[],
  report: (field: string) => void,
) {
  for (const field of Object.keys(table)) if (!known.includes(field)) report(field);
}

export function requiredString(
  table: Table,
  field: string,
  fail: (message: string) => void,
): string | undefined {
  const value = table[field];
  if (value === undefined) fail(`missing field "${field}"`);
  else if (typeof value !== "string" || !value.trim())
    fail(`field "${field}" must be a non-empty string`);
  else return value;
  return undefined;
}

function stringList(
  table: Table,
  field: string,
  fail: (message: string) => void,
): string[] | undefined {
  const value: unknown = table[field];
  if (value === undefined) fail(`missing field "${field}"`);
  else if (!Array.isArray(value)) fail(`field "${field}" must be a list`);
  else {
    const names = value.filter((each): each is string => typeof each === "string" && !!each.trim());
    if (names.length === value.length) return names;
    fail(`field "${field}" must list non-empty strings`);
  }
  return undefined;
}

export function optionalString(
  table: Table,
  field: string,
  fail: (message: string) => void,
): string | undefined {
  return table[field] === undefined ? undefined : requiredString(table, field, fail);
}
