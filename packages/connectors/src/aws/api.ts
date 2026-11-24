import { type Fetch, parseObject } from "@keypin/core";
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

export interface JsonReply {
  status: number;
  body: Record<string, unknown>;
  code: string | null;
}

function endpoint(service: string, region: string): string {
  return `https://${service}.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}/`;
}

export async function query(
  fetch: Fetch,
  service: Service,
  credentials: Credentials,
  action: string,
  params: Readonly<Record<string, string>>,
  now: Date,
  region?: string,
): Promise<Reply> {
  const { version } = SERVICES[service];
  const url = region === undefined ? SERVICES[service].url : endpoint(service, region);
  const body = new URLSearchParams({ Action: action, Version: version, ...params }).toString();
  const { headers } = signing(
    {
      method: "POST",
      url,
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body,
    },
    credentials,
    { region: region ?? REGION, service },
    now,
  );
  return xmlReply(await fetch(url, { method: "POST", headers, body }));
}

export async function unsignedQuery(
  fetch: Fetch,
  service: Service,
  action: string,
  params: Readonly<Record<string, string>>,
  region: string,
): Promise<Reply> {
  const { version } = SERVICES[service];
  const response = await fetch(endpoint(service, region), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: new URLSearchParams({ Action: action, Version: version, ...params }).toString(),
    redirect: "error",
  });
  return xmlReply(response);
}

async function xmlReply(response: Response): Promise<Reply> {
  const xml = await response.text();
  const code = response.status === 200 ? null : text(xml, "Code");
  return { status: response.status, xml, code: errorCode(code) };
}

export async function json(
  fetch: Fetch,
  service: string,
  credentials: Credentials,
  region: string,
  action: string,
  params: Readonly<Record<string, unknown>>,
  now: Date,
): Promise<JsonReply> {
  const url = endpoint(service, region);
  const body = JSON.stringify(params);
  const { headers } = signing(
    {
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `${service}.${action}`,
      },
      body,
    },
    credentials,
    { region, service },
    now,
  );
  const response = await fetch(url, { method: "POST", headers, body });
  const parsed = parseObject(await response.text());
  const type = typeof parsed.__type === "string" ? parsed.__type.split("#").pop() : null;
  return {
    status: response.status,
    body: parsed,
    code: response.status === 200 ? null : errorCode(type ?? null),
  };
}

function errorCode(code: string | null): string | null {
  return code && /^[A-Za-z.]+$/.test(code) ? code : null;
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

export function returned(action: string, reply: { status: number; code: string | null }): string {
  return `AWS ${action} returned HTTP ${reply.status}${reply.code ? ` ${reply.code}` : ""}`;
}
