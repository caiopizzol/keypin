import { assert, describe, expect, test } from "vite-plus/test";
import { type StatusRow, statusFile, writeStatusFile } from "../src/index";
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
