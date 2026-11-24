import { type Fetch, isRecord, objectField, parseObject } from "@keypin/core";

export const API = "https://apikeys.googleapis.com/v2";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export async function call(
  fetch: Fetch,
  token: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<Reply> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: parseObject(await response.text()) };
}

export function statusOf(error: Record<string, unknown>): string | null {
  const status = error.status;
  return typeof status === "string" && /^[A-Z_]+$/.test(status) ? status : null;
}

export function disabledIn(reply: Reply): string | null {
  const details = objectField(reply.body, "error").details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (!isRecord(detail) || detail.reason !== "SERVICE_DISABLED") continue;
    const consumer = objectField(detail, "metadata").consumer;
    return typeof consumer === "string" ? consumer.replace(/^projects\//, "") : "";
  }
  return null;
}

const POLICIES = new Set([
  "constraints/iam.disableServiceAccountKeyCreation",
  "constraints/iam.managed.disableServiceAccountKeyCreation",
]);

export function blockedBy(reply: Reply): string | null {
  const details = objectField(reply.body, "error").details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (!isRecord(detail) || !Array.isArray(detail.violations)) continue;
    for (const violation of detail.violations) {
      const type = isRecord(violation) ? violation.type : undefined;
      if (typeof type === "string" && POLICIES.has(type)) return type.replace(/^constraints\//, "");
    }
  }
  return null;
}

export function returned(method: string, path: string, reply: Reply): string {
  const status = statusOf(objectField(reply.body, "error"));
  return `Google ${method} ${path} returned HTTP ${reply.status}${status ? ` ${status}` : ""}`;
}

export function apiDisabled(
  api: string,
  title: string,
  project: string,
): { reason: string; fix: string } {
  const where = project ? ` in project ${project}` : "";
  return {
    reason: `the ${title} is turned off${where}, the admin service account's project`,
    fix: `turn on ${api} at https://console.cloud.google.com/apis/library/${api}${project ? `?project=${encodeURIComponent(project)}` : ""}`,
  };
}
