import { describe, expect, test } from "vite-plus/test";
import {
  addDays,
  buildStatus,
  periodDays,
  type MapResult,
  type ProblemKind,
  type Rotation as SavedRotation,
  type StatusInput,
  type VaultMetadata,
} from "../src/index";
import { GITHUB, KEY, receipt, WORKER } from "./fixtures";

const TODAY = "2026-11-09";
const PROJECT = "/work/billing";

interface Rotation {
  rotated: string | null;
  rotateEvery: string | null;
}

function status(rotation: Rotation | null, overrides: Partial<StatusInput> = {}) {
  const rotateEvery = rotation?.rotateEvery ?? "365d";
  const map: MapResult = {
    ok: true,
    map: {
      file: `${PROJECT}/keypin.toml`,
      account: "my.1password.com",
      environments: ["dev", "prod"],
      keys: [{ ...KEY, rotateEvery }],
    },
  };
  const metadata: VaultMetadata | null = rotation && { rotated: rotation.rotated };
  return buildStatus({
    registry: { version: 1, projects: [PROJECT], shared: [] },
    maps: new Map([[PROJECT, map]]),
    receipts: [receipt(WORKER, "aaaaaaaaaaaaaaaa"), receipt(GITHUB, "aaaaaaaaaaaaaaaa")],
    metadata: () => metadata,
    today: TODAY,
    ...overrides,
  });
}

const kinds = (result: ReturnType<typeof buildStatus>) => result.problems.map((p) => p.kind);

describe("receipts in status follow the destination, like publish", () => {
  const rotation = { rotated: "2026-11-01", rotateEvery: "365d" };

  test("another key's receipt from the same item counts, so no receipt goes missing for good", () => {
    const fromTwin = (id: string) => receipt(id, "bbbbbbbbbbbbbbbb", { keyId: "billing-twin" });
    const result = status(rotation, { receipts: [fromTwin(WORKER), fromTwin(GITHUB)] });
    expect(kinds(result)).not.toContain("missing-receipt");
    expect(result.rows[0]?.destinations.map((d) => d.receipt?.generation)).toEqual([
      "bbbbbbbbbbbbbbbb",
      "bbbbbbbbbbbbbbbb",
    ]);
  });

  test("another key's receipt from another item doesn't count", () => {
    const other = {
      kind: "1password",
      account: "a",
      vault: "v",
      item: "x",
      section: null,
      field: "password",
    } as const;
    const result = status(rotation, {
      receipts: [
        receipt(WORKER, "aaaaaaaaaaaaaaaa"),
        receipt(GITHUB, "bbbbbbbbbbbbbbbb", { keyId: "other", source: other }),
      ],
    });
    expect(result.problems.filter((p) => p.kind === "missing-receipt")).toMatchObject([
      { destinationId: GITHUB },
    ]);
  });

  test("another project's receipt for the same variable and environment, from another item, doesn't count", () => {
    const other = {
      kind: "1password",
      account: "a",
      vault: "v",
      item: "x",
      section: null,
      field: "password",
    } as const;
    const result = status(rotation, {
      receipts: [
        receipt(WORKER, "aaaaaaaaaaaaaaaa"),
        receipt(GITHUB, "bbbbbbbbbbbbbbbb", { mapFile: "/work/web/keypin.toml", source: other }),
      ],
    });
    expect(result.problems.filter((p) => p.kind === "missing-receipt")).toMatchObject([
      { destinationId: GITHUB },
    ]);
  });
});

describe("unfinished rotations in status", () => {
  const ref = KEY.environments.prod?.ref;
  const saved = (mapFile: string | null): SavedRotation => ({
    id: "r1",
    keyId: KEY.name,
    environment: "prod",
    mapFile,
    item: ref ?? {
      kind: "1password",
      account: "a",
      vault: "v",
      item: "i",
      section: null,
      field: "f",
    },
    provider: "cloudflare-account-token",
    account: "11111111111111111111111111111111",
    stage: "published",
    startedAt: "2026-11-10T12:00:00.000Z",
    updatedAt: "2026-11-10T12:00:05.000Z",
    old: { id: "a".repeat(32), name: "old", expiresOn: null, generation: "0123456789abcdef" },
    new: { id: "b".repeat(32), name: "new", expiresOn: null, generation: "fedcba9876543210" },
  });
  const rotation = { rotated: "2026-11-01", rotateEvery: "365d" };

  test("this project's rotation is a notice", () => {
    const result = status(rotation, { rotations: [saved(`${PROJECT}/keypin.toml`)] });
    expect(kinds(result)).toContain("rotation-unfinished");
  });

  test("another project's rotation of the same variable, environment and item isn't shown here", () => {
    const result = status(rotation, { rotations: [saved("/work/web/keypin.toml"), saved(null)] });
    expect(kinds(result)).not.toContain("rotation-unfinished");
  });
});

describe("rotation periods and dates", () => {
  test.each([
    ["90d", 90],
    ["12w", 84],
    ["6m", 180],
    ["never", null],
    ["0d", undefined],
    ["soon", undefined],
    ["1y", undefined],
    [null, undefined],
  ] as const)("%s", (period, days) => {
    expect(periodDays(period)).toBe(days);
  });

  test("addDays crosses months and years", () => {
    expect(addDays("2026-11-09", 180)).toBe("2027-05-08");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });
});

describe("status", () => {
  test("nothing due: only the authority notice, never a problem", () => {
    const result = status({ rotated: "2026-11-09", rotateEvery: "365d" });
    expect(kinds(result)).toEqual(["authority-unknown"]);
    expect(result.problems.every((p) => p.severity === "notice")).toBe(true);
    expect(result.rows).toEqual([
      expect.objectContaining({
        project: PROJECT,
        keyId: KEY.name,
        environment: "prod",
        rotated: "2026-11-09",
        due: "2027-11-09",
        authority: "unknown",
        destinations: [
          expect.objectContaining({ destinationId: WORKER, stale: null }),
          expect.objectContaining({ destinationId: GITHUB, stale: null }),
        ],
      }),
    ]);
  });

  test.each<[string, Rotation | null, ProblemKind, string]>([
    [
      "overdue",
      { rotated: "2025-01-01", rotateEvery: "90d" },
      "overdue",
      "was due 2025-04-01 (rotated 2025-01-01, every 90d)",
    ],
    [
      "due within 14 days",
      { rotated: "2026-08-14", rotateEvery: "90d" },
      "due-soon",
      "is due 2026-11-12",
    ],
    [
      "due in exactly 14 days",
      { rotated: "2026-08-25", rotateEvery: "90d" },
      "due-soon",
      "is due 2026-11-23",
    ],
    [
      "no rotation date",
      { rotated: null, rotateEvery: "90d" },
      "no-rotation-date",
      "no rotated date",
    ],
    [
      "a rotation date that isn't a day",
      { rotated: "2026-02-30", rotateEvery: "90d" },
      "no-rotation-date",
      `rotated "2026-02-30" isn't YYYY-MM-DD`,
    ],
    [
      "a bad period",
      { rotated: "2026-11-09", rotateEvery: "soon" },
      "bad-rotation-period",
      `rotate_every is "soon"`,
    ],
    ["unreadable fields", null, "rotation-unreadable", "couldn't be read"],
  ])("%s", (_, rotation, kind, message) => {
    const problem = status(rotation).problems.find((p) => p.kind === kind);
    expect(problem?.message).toContain(message);
    expect(problem?.severity).toBe(kind === "due-soon" ? "notice" : "problem");
  });

  test("due in 15 days is not due soon, and never is never due", () => {
    expect(kinds(status({ rotated: "2026-08-26", rotateEvery: "90d" }))).toEqual([
      "authority-unknown",
    ]);
    const never = status({ rotated: "2020-01-01", rotateEvery: "never" });
    expect(kinds(never)).toEqual(["authority-unknown"]);
    expect(never.rows[0]?.due).toBeNull();
  });

  test("no rotate_every in the map says where to add one", () => {
    const map: MapResult = {
      ok: true,
      map: {
        file: "keypin.toml",
        account: "my.1password.com",
        environments: ["dev", "prod"],
        keys: [{ ...KEY, rotateEvery: null }],
      },
    };
    const result = status(
      { rotated: "2026-11-09", rotateEvery: null },
      { maps: new Map([[PROJECT, map]]) },
    );
    expect(result.problems.find((p) => p.kind === "bad-rotation-period")).toMatchObject({
      severity: "problem",
      message: `${KEY.name} (prod): keypin.toml has no rotate_every for this key; add one, such as "90d", or "never"`,
    });
  });

  test("a destination with no receipt", () => {
    const result = status(
      { rotated: "2026-11-09", rotateEvery: "365d" },
      { receipts: [receipt(WORKER, "aaaaaaaaaaaaaaaa")] },
    );
    expect(result.problems.filter((p) => p.kind === "missing-receipt")).toEqual([
      expect.objectContaining({ destinationId: GITHUB, severity: "problem" }),
    ]);
    expect(result.rows[0]?.destinations[1]?.receipt).toBeNull();
  });

  test("a stale receipt, when the caller knows the current generation", () => {
    const receipts = [receipt(WORKER, "aaaaaaaaaaaaaaaa"), receipt(GITHUB, "bbbbbbbbbbbbbbbb")];
    const result = status(
      { rotated: "2026-11-09", rotateEvery: "365d" },
      { receipts, generation: () => "aaaaaaaaaaaaaaaa" },
    );
    expect(result.problems.filter((p) => p.kind === "stale-receipt")).toEqual([
      expect.objectContaining({
        destinationId: GITHUB,
        message: `${KEY.name} (prod): ${GITHUB} last got generation bbbbbbbbbbbbbbbb, and the value is now aaaaaaaaaaaaaaaa`,
      }),
    ]);
    expect(result.rows[0]?.destinations.map((d) => d.stale)).toEqual([false, true]);
  });

  test("a project with no map or a bad map is a problem, not silence", () => {
    const result = buildStatus({
      registry: { version: 1, projects: ["/work/a", "/work/b"], shared: [] },
      maps: new Map<string, MapResult>([
        ["/work/b", { ok: false, errors: ["/work/b/keypin.toml: missing field"] }],
      ]),
      receipts: [],
      metadata: () => null,
      today: TODAY,
    });
    expect(result.problems.map((p) => [p.kind, p.project])).toEqual([
      ["no-map", "/work/a"],
      ["bad-map", "/work/b"],
    ]);
  });

  test("today must be a day", () => {
    expect(() => status(null, { today: "11/09/2026" })).toThrow(
      'today must be YYYY-MM-DD, got "11/09/2026"',
    );
  });
});
