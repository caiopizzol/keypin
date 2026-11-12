import type { Api } from "../src/api";
import type { Auth, Profile, Signup, SignupStore } from "../src/signup";

export const ORIGIN = "https://keypin.dev";

export function fakeAuth(users: Record<string, { userId: string; profile: Profile }>): Auth {
  return {
    async verify(token) {
      return users[token]?.userId ?? null;
    },
    async profile(userId) {
      const user = Object.values(users).find((candidate) => candidate.userId === userId);
      if (!user) throw new Error(`No fake user ${userId}`);
      return user.profile;
    },
  };
}

export function memoryStore(): SignupStore {
  const rows = new Map<string, Signup>();
  return {
    async get(userId) {
      return rows.get(userId) ?? null;
    },
    async put(userId, profile, answers, now) {
      const signup = {
        ...profile,
        ...answers,
        createdAt: rows.get(userId)?.createdAt ?? now,
        updatedAt: now,
      };
      rows.set(userId, signup);
      return signup;
    },
    async delete(userId) {
      rows.delete(userId);
    },
  };
}

export function fakeApi(): Api {
  let tick = 0;
  return {
    publishableKey: "pk_test_fake",
    siteOrigin: ORIGIN,
    auth: fakeAuth({
      "good-token": {
        userId: "user_1",
        profile: { githubLogin: "octocat", email: "octocat@example.com" },
      },
    }),
    store: memoryStore(),
    now: () => new Date(Date.UTC(2026, 10, 12, 12, 0, tick++)).toISOString(),
    log: () => {},
  };
}
