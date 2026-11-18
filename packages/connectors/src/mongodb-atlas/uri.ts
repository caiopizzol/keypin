export interface MongoUri {
  scheme: "mongodb" | "mongodb+srv";
  username: string;
  hosts: string[];
  address: string;
  rest: string;
  options: URLSearchParams;
}

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
  const hosts = hostList(address);
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
  const authority = SCHEME.exec(connectionString.trim())?.[2] ?? "";
  return hostList(authority.slice(authority.lastIndexOf("@") + 1));
}

function hostList(address: string): string[] {
  const hosts = address.split(",").map((host) => host.replace(/:\d+$/, "").toLowerCase());
  return hosts.every(Boolean) ? hosts : [];
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return "";
  }
}
