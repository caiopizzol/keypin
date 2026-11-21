export type Json = Record<string, unknown>;

export function problem(response: { status: number; body: Json }): string {
  const message = typeof response.body.message === "string" ? `: ${response.body.message}` : "";
  return `Infisical returned HTTP ${response.status}${message}`;
}
