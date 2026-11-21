import { isRecord } from "@keypin/core";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export interface Operation {
  id: string;
  action: string;
  status: string;
}

export function passwordTimes(body: Record<string, unknown>): Map<string, string> {
  const roles = Array.isArray(body.roles) ? body.roles : [];
  return new Map(
    roles.flatMap((role: unknown) =>
      isRecord(role) && typeof role.name === "string" && typeof role.updated_at === "string"
        ? [[role.name, role.updated_at] as const]
        : [],
    ),
  );
}

export function operationsOf(body: Record<string, unknown>): Operation[] {
  const operations = Array.isArray(body.operations) ? body.operations : [];
  return operations.flatMap((operation: unknown) =>
    isRecord(operation) && typeof operation.id === "string" && typeof operation.status === "string"
      ? [
          {
            id: operation.id,
            status: operation.status,
            action: typeof operation.action === "string" ? operation.action : "unknown",
          },
        ]
      : [],
  );
}

export function endpointIds(body: Record<string, unknown>): Set<string> {
  const endpoints = Array.isArray(body.endpoints) ? body.endpoints : [];
  return new Set(
    endpoints.flatMap((endpoint: unknown) =>
      isRecord(endpoint) && typeof endpoint.id === "string" ? [endpoint.id] : [],
    ),
  );
}

export function failure(
  method: string,
  path: string,
  reply: Reply,
  type: new (message: string) => Error = Error,
): Error {
  return new type(`Neon ${method} ${path} returned HTTP ${reply.status}${codeOf(reply)}`);
}

export function codeOf(reply: Reply): string {
  const code = reply.body.code;
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? ` ${code}` : "";
}
