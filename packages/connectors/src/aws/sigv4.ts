import { createHash, createHmac } from "node:crypto";

export interface Credentials {
  readonly id: string;
  readonly secret: string;
}

export interface Unsigned {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface Scope {
  readonly region: string;
  readonly service: string;
}

export interface Signing {
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  headers: Record<string, string>;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

const sha256 = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data, "utf8").digest();

export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

function uriEncode(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(search: string): string {
  if (search.length <= 1) return "";
  return search
    .slice(1)
    .split("&")
    .map((pair) => {
      const at = pair.indexOf("=");
      const [name, value] = at < 0 ? [pair, ""] : [pair.slice(0, at), pair.slice(at + 1)];
      return [uriEncode(decodeURIComponent(name)), uriEncode(decodeURIComponent(value))] as const;
    })
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

export function signing(
  request: Unsigned,
  credentials: Credentials,
  scope: Scope,
  now: Date,
): Signing {
  const url = new URL(request.url);
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const lowered = new Map<string, string>();
  for (const [name, value] of Object.entries(request.headers))
    lowered.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  lowered.set("host", url.host);
  lowered.set("x-amz-date", date);
  const names = [...lowered.keys()].sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method,
    url.pathname.split("/").map(uriEncode).join("/") || "/",
    canonicalQuery(url.search),
    names.map((name) => `${name}:${lowered.get(name)}\n`).join(""),
    signedHeaders,
    sha256(request.body),
  ].join("\n");
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = [ALGORITHM, date, credentialScope, sha256(canonicalRequest)].join("\n");
  const key = [day, scope.region, scope.service, "aws4_request"].reduce<Buffer | string>(
    (signed, part) => hmac(signed, part),
    `AWS4${credentials.secret}`,
  );
  const signature = hmac(key, stringToSign).toString("hex");
  const headers: Record<string, string> = {
    ...request.headers,
    "X-Amz-Date": date,
    Authorization: `${ALGORITHM} Credential=${credentials.id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  return { canonicalRequest, stringToSign, signature, headers };
}
