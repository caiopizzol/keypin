import { type Fetch, isRecord, parseObject } from "@keypin/core";

const API = "https://api.cloudflare.com/client/v4";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export async function call(
  fetch: Fetch,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  type = "application/json",
): Promise<Reply> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": type }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: parseObject(await response.text()) };
}

export function errorCodes(reply: Reply): number[] {
  const errors = Array.isArray(reply.body.errors) ? reply.body.errors.filter(isRecord) : [];
  return errors.map((e) => e.code).filter((c) => typeof c === "number");
}

export function returned(
  method: string,
  path: string,
  reply: Reply,
  hidden?: readonly string[],
): string {
  const errors = Array.isArray(reply.body.errors) ? reply.body.errors.filter(isRecord) : [];
  const codes = errorCodes(reply);
  const secrets = (hidden ?? []).flatMap((h) => [h, h.trim()]).filter((h) => h);
  const said = hidden
    ? errors
        .map((e) => (typeof e.message === "string" ? e.message : ""))
        .filter((m) => !secrets.some((h) => m.includes(h)))
        .map((m) => m.trim())
        .filter((m) => m)
    : [];
  const where = `Cloudflare ${method} ${path.split("?")[0]} returned HTTP ${reply.status}`;
  const detail = [
    ...(codes.length ? [`codes ${codes.join(", ")}`] : []),
    ...(said.length ? [`"${said.join("; ")}"`] : []),
  ];
  return `${where}${detail.length ? `, ${detail.join(", ")}` : ""}`;
}
