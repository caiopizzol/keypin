export const TOKEN_VARIABLE = "KEYPIN_CONVEX_DEPLOY_KEY";
export const SETTINGS_PAGE = "https://dashboard.convex.dev/deployment/settings";
export const PERMISSION = "deployment:env:write";

export class ConvexSignInFailed extends Error {}

export interface ConvexSignIn {
  key(): Promise<string>;
}

export function convexSignIn(env: Readonly<Record<string, string | undefined>>): ConvexSignIn {
  const value = env[TOKEN_VARIABLE];
  return {
    key: async () => {
      const key = value?.trim() ?? "";
      if (key) return key;
      throw new ConvexSignInFailed(signInProblem(env));
    },
  };
}

export function signInProblem(env: Readonly<Record<string, string | undefined>>): string {
  const set = env[TOKEN_VARIABLE] === undefined ? "isn't set" : "is set but empty";
  const ambient = env.CONVEX_DEPLOY_KEY
    ? "; CONVEX_DEPLOY_KEY is set, but keypin doesn't sign in with it, so it stays a key your map can hold"
    : "";
  return `keypin signs in to Convex with ${TOKEN_VARIABLE}, which ${set}${ambient}. Generate a deploy key with ${PERMISSION} in the deployment's settings (${SETTINGS_PAGE}) and set ${TOKEN_VARIABLE}; keypin doesn't read the npx convex login`;
}

export type KeyKind =
  | { kind: "deployment"; type: string; name: string }
  | { kind: "admin"; name: string }
  | { kind: "project" }
  | { kind: "preview" }
  | { kind: "unknown" };

const TYPES = ["dev", "prod", "preview", "custom"];

export function keyKind(key: string): KeyKind {
  const bar = key.indexOf("|");
  if (bar < 1 || bar === key.length - 1) return { kind: "unknown" };
  const parts = key.slice(0, bar).split(":");
  const [first = "", second = ""] = parts;
  if (parts.length === 1) return { kind: "admin", name: first };
  if (first === "project") return { kind: "project" };
  if (first === "preview" && parts.length === 3) return { kind: "preview" };
  if (parts.length === 2 && TYPES.includes(first) && second)
    return { kind: "deployment", type: first, name: second };
  return { kind: "unknown" };
}
