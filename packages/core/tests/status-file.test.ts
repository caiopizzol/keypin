import { assert, describe, expect, test } from "vite-plus/test";
import {
  objectField,
  parseObject,
  type RotationRecord,
  statusDates,
  statusEntries,
  type StatusRow,
  statusFile,
  writeStatusFile,
} from "../src/index";
import { day } from "../src/testing/day";
import { fakeFiles, KEY } from "./fixtures";

const PROD = KEY.environments.prod;
assert(PROD);
const REF = PROD.ref;

function row(keyId: string, environment: string, rotated: string | null): StatusRow {
  return {
    project: "/work/billing",
    keyId,
    environment,
    ref: REF,
    rotated: rotated === null ? null : day(rotated),
    rotateEvery: "90d",
    due: rotated === null ? null : day("2027-01-01"),
    issuer: "resend",
    destinations: [
      {
        destinationId: "github-actions:acme/billing:STRIPE_API_KEY",
        account: "acme",
        receipt: { generation: "0123456789abcdef", at: "2026-11-09T15:30:35Z", publisher: "me" },
        stale: false,
      },
    ],
  };
}

const ROWS = [
  row("STRIPE_API_KEY", "prod", "2026-10-23"),
  row("STRIPE_API_KEY", "dev", null),
  row("API_TOKEN", "prod", "2026-11-01"),
];

describe("the status file", () => {
  test("holds each key's rotated day per environment, keys sorted and environments in map order", () => {
    const file = statusFile(ROWS, ["dev", "prod"], day("2026-11-09"));
    expect(JSON.stringify(file, null, 2)).toBe(
      JSON.stringify(
        {
          version: 1,
          written: "2026-11-09",
          keys: {
            API_TOKEN: { prod: { rotated: "2026-11-01" } },
            STRIPE_API_KEY: { dev: { rotated: null }, prod: { rotated: "2026-10-23" } },
          },
        },
        null,
        2,
      ),
    );
  });

  test("keeps a key named __proto__ as an ordinary key", () => {
    const file = statusFile([row("__proto__", "prod", "2026-10-23")], ["prod"], day("2026-11-09"));
    expect(Object.keys(file.keys)).toEqual(["__proto__"]);
    expect(JSON.stringify(file.keys)).toBe('{"__proto__":{"prod":{"rotated":"2026-10-23"}}}');
  });

  test("holds no reference, item, account, path, receipt, generation or due day", () => {
    const text = JSON.stringify(statusFile(ROWS, ["dev", "prod"], day("2026-11-09")));
    for (const absent of [
      "op://",
      REF.kind,
      "billing stripe api key",
      "Private",
      "my.1password.com",
      "/work",
      "acme",
      "0123456789abcdef",
      "2027-01-01",
      "90d",
      "resend",
      "ref",
      "due",
    ])
      expect(text).not.toContain(absent);
  });

  test("is written once, and left alone while the dates stay the same", async () => {
    const { files, contents } = fakeFiles();
    const path = "/work/billing/.keypin/status.json";
    const first = statusFile(ROWS, ["dev", "prod"], day("2026-11-09"));
    expect(await writeStatusFile(files, path, first)).toBe("written");
    const text = contents.get(path);
    expect(text?.endsWith("}\n")).toBe(true);

    const later = statusFile(ROWS, ["dev", "prod"], day("2026-11-20"));
    expect(await writeStatusFile(files, path, later)).toBe("unchanged");
    expect(contents.get(path)).toBe(text);

    const rotated = statusFile(
      [...ROWS.slice(1), row("STRIPE_API_KEY", "prod", "2026-11-20")],
      ["dev", "prod"],
      day("2026-11-20"),
    );
    expect(await writeStatusFile(files, path, rotated)).toBe("written");
    expect(contents.get(path)).toContain('"written": "2026-11-20"');
  });

  test("replaces a file that isn't valid JSON", async () => {
    const path = "/work/billing/.keypin/status.json";
    const { files, contents } = fakeFiles({ [path]: "{ not json" });
    const file = statusFile(ROWS, ["dev", "prod"], day("2026-11-09"));
    expect(await writeStatusFile(files, path, file)).toBe("written");
    expect(contents.get(path)).toContain('"version": 1');
  });
});

const RECORDS: Record<string, RotationRecord> = {
  "STRIPE_API_KEY prod": {
    at: "2026-10-23T09:00:00.000Z",
    published: ["github-actions:acme/billing"],
    unpublished: [],
    old: "waiting for approval",
  },
  "API_TOKEN prod": {
    at: "2026-11-01T09:00:00.000Z",
    published: [],
    unpublished: ["github-actions:acme/billing"],
    old: "still in use",
  },
  "API_TOKEN dev": {
    at: "2026-10-30T09:00:00.000Z",
    published: ["github-actions:acme/billing"],
    unpublished: [],
    old: "revoked",
  },
  "MAIL_KEY prod": {
    at: "2026-11-05T09:00:00.000Z",
    published: [],
    unpublished: ["github-actions:acme/billing"],
    old: "unknown",
  },
};

const WRITTEN = JSON.stringify(
  statusFile(
    [
      ...ROWS,
      row("API_TOKEN", "dev", "2026-10-30"),
      row("MAIL_KEY", "prod", "2026-11-05"),
      row("QUIET_KEY", "prod", "2026-09-01"),
    ],
    ["dev", "prod"],
    day("2026-11-09"),
    (keyId, environment) => RECORDS[`${keyId} ${environment}`] ?? null,
  ),
  null,
  2,
);

function edited(change: (keys: Record<string, unknown>) => void): string {
  const file = parseObject(WRITTEN);
  change(objectField(file, "keys"));
  return JSON.stringify(file, null, 2);
}

function readRecording(text: string): string {
  return `--- file ---\n${text}\n--- read ---\n${JSON.stringify(statusEntries(text), null, 2)}\n`;
}

describe("reading the status file back", () => {
  test("gives each key's rotated day and rotation per environment, as keypin wrote them", async () => {
    await expect(readRecording(WRITTEN)).toMatchFileSnapshot(
      "./recordings/status-file/rotations.txt",
    );
  });

  test("agrees with statusDates on every rotated day", () => {
    const dates = statusDates(WRITTEN);
    for (const [keyId, environments] of Object.entries(statusEntries(WRITTEN) ?? {}))
      for (const [environment, entry] of Object.entries(environments))
        expect(entry.rotated).toBe(dates(keyId, environment));
  });

  test("drops only the entries it can't read and keeps the rest", async () => {
    const text = edited((keys) => {
      keys.STRIPE_API_KEY = {
        dev: { rotated: 20261023 },
        prod: { rotated: "2026-10-23", rotation: { old: "gone" } },
      };
      Object.assign(objectField(keys, "API_TOKEN"), {
        prod: {
          rotated: "2026-11-01",
          rotation: { at: "2026-11-01T09:00:00.000Z", published: [], old: "still in use" },
        },
      });
      Object.assign(objectField(keys, "QUIET_KEY"), {
        dev: "2026-09-01",
        staging: { rotated: "2026-02-30" },
      });
      keys.MAIL_KEY = { prod: {}, dev: { rotated: "2026-11-05T09:00:00Z" } };
      keys.LOST_KEY = "2026-09-01";
    });
    await expect(readRecording(text)).toMatchFileSnapshot(
      "./recordings/status-file/bad-entries.txt",
    );
  });

  test("reads nothing from a missing file, invalid JSON or another version", () => {
    expect(statusEntries(null)).toBeNull();
    expect(statusEntries("{ not json")).toBeNull();
    expect(statusEntries(JSON.stringify({ version: 2, keys: {} }))).toBeNull();
  });

  test("keeps keys and environments named __proto__, constructor or toString as ordinary names", async () => {
    const text = JSON.stringify(
      statusFile(
        [row("__proto__", "constructor", "2026-10-23"), row("toString", "prod", "2026-11-01")],
        ["constructor", "prod"],
        day("2026-11-09"),
      ),
      null,
      2,
    );
    const entries = statusEntries(text);
    await expect(readRecording(text)).toMatchFileSnapshot(
      "./recordings/status-file/special-names.txt",
    );
    expect(Object.keys(entries ?? {})).toEqual(["__proto__", "toString"]);
    const key = (keyId: string) => entries?.[keyId];
    expect(key("__proto__")?.["constructor"]?.rotated).toBe("2026-10-23");
    expect(key("toString")?.["constructor"]).toBeUndefined();
    expect(key("__proto__")?.["toString"]).toBeUndefined();
    expect(key("constructor")).toBeUndefined();
    expect(key("hasOwnProperty")).toBeUndefined();
  });
});
