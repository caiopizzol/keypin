import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { type D1, d1Store } from "../src/store";

function sqliteD1(db: Database): D1 {
  return {
    prepare(query) {
      const statement = (values: (string | null)[]) => ({
        bind: (...next: (string | null)[]) => statement(next),
        first: async <T>() => db.query<T, (string | null)[]>(query).get(...values),
        run: async () => db.query(query).run(...values),
      });
      return statement([]);
    },
  };
}

const migration = readFileSync(new URL("../migrations/0001_signups.sql", import.meta.url), "utf8");
const profile = { githubLogin: "octocat", email: "octocat@example.com" };

describe("d1Store against the migration's SQL", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.run(migration);
  });

  test("put, get, upsert keeping created_at, delete", async () => {
    const store = d1Store(sqliteD1(db));
    expect(await store.get("user_1")).toBeNull();

    const first = await store.put(
      "user_1",
      profile,
      { use: "team", teamSize: "51+", note: "hi" },
      "2026-11-12T12:00:00.000Z",
    );
    expect(first).toEqual({
      ...profile,
      use: "team",
      teamSize: "51+",
      note: "hi",
      createdAt: "2026-11-12T12:00:00.000Z",
      updatedAt: "2026-11-12T12:00:00.000Z",
    });
    expect(await store.get("user_1")).toEqual(first);

    const second = await store.put(
      "user_1",
      { ...profile, email: null },
      { use: "solo", teamSize: null, note: null },
      "2026-11-13T08:00:00.000Z",
    );
    expect(second).toEqual({
      githubLogin: "octocat",
      email: null,
      use: "solo",
      teamSize: null,
      note: null,
      createdAt: "2026-11-12T12:00:00.000Z",
      updatedAt: "2026-11-13T08:00:00.000Z",
    });

    await store.delete("user_1");
    expect(await store.get("user_1")).toBeNull();
    await store.delete("user_1");
  });

  test("keeps users apart", async () => {
    const store = d1Store(sqliteD1(db));
    await store.put(
      "user_1",
      profile,
      { use: "solo", teamSize: null, note: null },
      "2026-11-12T12:00:00.000Z",
    );
    expect(await store.get("user_2")).toBeNull();
  });

  test("the table rejects values outside the contract", () => {
    expect(() =>
      db.run(
        "INSERT INTO signups (user_id, use, created_at, updated_at) VALUES ('u', 'company', 'a', 'a')",
      ),
    ).toThrow();
    expect(() =>
      db.run(
        "INSERT INTO signups (user_id, use, team_size, created_at, updated_at) VALUES ('u', 'team', '5', 'a', 'a')",
      ),
    ).toThrow();
  });
});
