import type { Fetch } from "@keypin/core";

const API = "https://api.supabase.com/v1";
export const TOKENS = "https://supabase.com/dashboard/account/tokens";
export const TOKEN_DOCS = "https://supabase.com/docs/guides/platform/personal-access-tokens";

export interface Reply {
  status: number;
  body: unknown;
}

export async function supabaseRequest(
  fetch: Fetch,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "keypin",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: parseJson(await response.text()) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
