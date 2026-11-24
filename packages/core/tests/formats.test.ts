import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  isRecord,
  loadRegistry,
  loadRotationFile,
  loadState,
  parseObject,
  statusEntries,
} from "../src/index";
import { fakeFiles, VAULT_KINDS } from "./fixtures";
import { type Format, FORMATS, formatPath, written } from "./formats";

const released = (format: Format) => readFileSync(formatPath(format), "utf8");

function fields(value: unknown, path: string, into: Map<string, boolean>): Map<string, boolean> {
  const children = Array.isArray(value)
    ? value.map((item) => [`${path}[]`, item] as const)
    : isRecord(value)
      ? Object.entries(value).map(
          ([name, item]) => [path ? `${path}.${name}` : name, item] as const,
        )
      : [];
  const empty = Array.isArray(value) && value.length === 0;
  if (path) into.set(path, into.get(path) === true || empty);
  for (const [child, item] of children) fields(item, child, into);
  return into;
}

function dropped(released: string, now: string): string[] {
  const current = fields(JSON.parse(now), "", new Map());
  const emptied = [...current].flatMap(([path, empty]) => (empty ? [path] : []));
  const under = (path: string, parent: string) =>
    path.startsWith(`${parent}.`) || path.startsWith(`${parent}[]`);
  return [...fields(JSON.parse(released), "", new Map()).keys()].filter(
    (path) => !current.has(path) && !emptied.some((parent) => under(path, parent)),
  );
}

describe("files the released keypin reads", () => {
  test.each(FORMATS)(
    "this keypin still writes every field of the released %s file",
    async (format) => {
      expect(
        dropped(released(format), (await written())[format]),
        "keep writing these fields, see docs/development.md#files-keypin-reads-back",
      ).toEqual([]);
    },
  );

  test("an empty list may drop its items' fields, an empty object or null may not", () => {
    const before = JSON.stringify({ issued: [{ old: { id: "a" } }], held: { at: 1 } });
    expect(dropped(before, JSON.stringify({ issued: [], held: { at: 2 } }))).toEqual([]);
    expect(dropped(before, JSON.stringify({ issued: [{ old: {} }], held: null }))).toEqual([
      "issued[].old.id",
      "held.at",
    ]);
  });

  test("this keypin reads the released state, registry and rotation files", async () => {
    const disk = fakeFiles(Object.fromEntries(FORMATS.map((f) => [f, released(f)])));
    expect((await loadState(disk.files, "state", VAULT_KINDS)).receipts).toHaveLength(1);
    expect((await loadRegistry(disk.files, "registry")).projects).toHaveLength(1);
    expect((await loadRotationFile(disk.files, "rotation"))?.published).toHaveLength(1);
  });

  test("this keypin reads every entry of the released status file", () => {
    const text = released("status");
    const keys = parseObject(text).keys;
    const entries = statusEntries(text);
    const unread = Object.entries(isRecord(keys) ? keys : {}).flatMap(([key, environments]) =>
      Object.keys(isRecord(environments) ? environments : {})
        .filter((environment) => entries?.[key]?.[environment] === undefined)
        .map((environment) => `${key}.${environment}`),
    );
    expect(entries).not.toBeNull();
    expect(unread).toEqual([]);
  });
});
