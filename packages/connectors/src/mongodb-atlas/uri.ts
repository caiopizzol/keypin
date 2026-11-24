import { isRecord } from "@keypin/core";

export interface MongoUri {
  scheme: "mongodb" | "mongodb+srv";
  username: string;
  hosts: string[];
  address: string;
  rest: string;
  options: URLSearchParams;
}

const DEFAULT_PORT = 27017;
const SCHEME = /^(mongodb(?:\+srv)?):\/\/([^/?]*)(.*)$/s;

export function parseUri(text: string): MongoUri | null {
  const match = SCHEME.exec(text.trim());
  if (!match) return null;
  const authority = match[2] ?? "";
  const rest = match[3] ?? "";
  const at = authority.lastIndexOf("@");
  const userinfo = authority.slice(0, Math.max(at, 0));
  const colon = userinfo.indexOf(":");
  const username = decoded(userinfo.slice(0, colon));
  if (at < 0 || colon < 0 || !username || !decoded(userinfo.slice(colon + 1))) return null;
  const address = authority.slice(at + 1);
  const hosts = hostList(match[1] ?? "", address);
  if (!hosts.length) return null;
  const query = rest.indexOf("?");
  return {
    scheme: match[1] === "mongodb+srv" ? "mongodb+srv" : "mongodb",
    username,
    hosts,
    address,
    rest,
    options: new URLSearchParams(query >= 0 ? rest.slice(query + 1) : ""),
  };
}

export function withUser(uri: MongoUri, username: string, password: string): string {
  const user = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
  return `${uri.scheme}://${user}@${uri.address}${uri.rest}`;
}

export function hostsOf(connectionString: unknown): string[] {
  if (typeof connectionString !== "string") return [];
  const match = SCHEME.exec(connectionString.trim());
  const authority = match?.[2] ?? "";
  return hostList(match?.[1] ?? "", authority.slice(authority.lastIndexOf("@") + 1));
}

function hostList(scheme: string, address: string): string[] {
  const hosts = address
    .split(",")
    .map((host) => (scheme === "mongodb+srv" ? host : withPort(host)).toLowerCase());
  return hosts.every(Boolean) ? hosts : [];
}

function withPort(host: string): string {
  return !host || /:\d+$/.test(host) ? host : `${host}:${DEFAULT_PORT}`;
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return "";
  }
}

export function connectionStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(connectionStrings);
  return isRecord(value) ? Object.values(value).flatMap(connectionStrings) : [];
}
