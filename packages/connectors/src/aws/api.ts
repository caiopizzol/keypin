import type { Fetch } from "@keypin/core";
import { type Credentials, signing } from "./sigv4";

export const IAM = "https://iam.amazonaws.com/";
export const STS = "https://sts.amazonaws.com/";
export const REGION = "us-east-1";

const SERVICES = {
  iam: { url: IAM, version: "2010-05-08" },
  sts: { url: STS, version: "2011-06-15" },
};

export type Service = keyof typeof SERVICES;

export interface Reply {
  status: number;
  xml: string;
  code: string | null;
}

export async function query(
  fetch: Fetch,
  service: Service,
  credentials: Credentials,
  action: string,
  params: Readonly<Record<string, string>>,
  now: Date,
): Promise<Reply> {
  const { url, version } = SERVICES[service];
  const body = new URLSearchParams({ Action: action, Version: version, ...params }).toString();
  const { headers } = signing(
    {
      method: "POST",
      url,
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body,
    },
    credentials,
    { region: REGION, service },
    now,
  );
  const response = await fetch(url, { method: "POST", headers, body });
  const xml = await response.text();
  const code = response.status === 200 ? null : text(xml, "Code");
  return { status: response.status, xml, code: code && /^[A-Za-z.]+$/.test(code) ? code : null };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function text(xml: string, tag: string): string | null {
  const found = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
  return found === undefined
    ? null
    : found.trim().replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name] ?? "");
}

export function members(xml: string): string[] {
  return [...xml.matchAll(/<member>([\s\S]*?)<\/member>/g)].map((m) => m[1] ?? "");
}

export function returned(action: string, reply: Reply): string {
  return `AWS ${action} returned HTTP ${reply.status}${reply.code ? ` ${reply.code}` : ""}`;
}
