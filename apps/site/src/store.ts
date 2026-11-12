import type { Answers, Profile, Signup, SignupStore, TeamSize, Use } from "./signup";

interface Statement {
  bind(...values: (string | null)[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1 {
  prepare(query: string): Statement;
}

interface Row {
  github_login: string | null;
  email: string | null;
  use: Use;
  team_size: TeamSize | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

function signup(row: Row): Signup {
  return {
    githubLogin: row.github_login,
    email: row.email,
    use: row.use,
    teamSize: row.team_size,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const UPSERT = `INSERT INTO signups (user_id, github_login, email, use, team_size, note, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
ON CONFLICT (user_id) DO UPDATE SET
  github_login = excluded.github_login,
  email = excluded.email,
  use = excluded.use,
  team_size = excluded.team_size,
  note = excluded.note,
  updated_at = excluded.updated_at
RETURNING *`;

export function d1Store(db: D1): SignupStore {
  return {
    async get(userId) {
      const row = await db
        .prepare("SELECT * FROM signups WHERE user_id = ?1")
        .bind(userId)
        .first<Row>();
      return row ? signup(row) : null;
    },
    async put(userId: string, profile: Profile, answers: Answers, now: string) {
      const row = await db
        .prepare(UPSERT)
        .bind(
          userId,
          profile.githubLogin,
          profile.email,
          answers.use,
          answers.teamSize,
          answers.note,
          now,
        )
        .first<Row>();
      if (!row) throw new Error("D1 returned no row for the upsert.");
      return signup(row);
    },
    async delete(userId) {
      await db.prepare("DELETE FROM signups WHERE user_id = ?1").bind(userId).run();
    },
  };
}
