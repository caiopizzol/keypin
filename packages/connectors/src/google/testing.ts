import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { type Fetch, isRecord, parseObject } from "@keypin/core";
import { TOKEN_URL } from "./auth";

export interface FakeGoogleKey {
  name: string;
  value: string;
  displayName?: string;
  restrictions?: Record<string, unknown>;
  serviceAccountEmail?: string;
  deleteTime?: string;
  purged?: boolean;
}

export interface GoogleWorld {
  keys: FakeGoogleKey[];
  created: number;
  operations: { name: string; polls: number; response: Record<string, unknown> }[];
}

export interface FakeGoogle {
  serviceAccount: string;
  privateKey: string;
  projects: readonly string[];
  valuePrefix: string;
  tokenPrefix?: string;
  apiDisabledIn?: string;
  pendingPolls?: number;
  failCreate?: number;
  failOperation?: boolean;
  noKeyString?: boolean;
  loseCreated?: boolean;
  world: { load(): GoogleWorld; save(world: GoogleWorld): void };
  effect(line: string): void;
}

const KEYS = /^\/v2\/(projects\/([^/]+)\/locations\/global\/keys)(?:\/([^/:]+))?(\/keyString)?$/;

export function serviceAccountJson(
  email: string,
  privateKey: string,
  keyId = "fake-key-id",
): string {
  return JSON.stringify({
    type: "service_account",
    project_id: email.split("@")[1]?.split(".")[0] ?? "fake",
    private_key_id: keyId,
    private_key: privateKey,
    client_email: email,
    token_uri: TOKEN_URL,
  });
}

export function fakePrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

export function googleFetch(fake: FakeGoogle): Fetch {
  const issued = new Set<string>();
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const refuse = (status: number, code: string, message: string, details: unknown[] = []) =>
    reply(status, { error: { code: status, message, status: code, details } });

  return async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(init.body ?? "");
      const [header = "", claims = "", signature = ""] = (form.get("assertion") ?? "").split(".");
      const decoded = (part: string) => parseObject(Buffer.from(part, "base64url").toString());
      const signed = verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        createPublicKey(fake.privateKey),
        Buffer.from(signature, "base64url"),
      );
      const said = decoded(claims);
      if (
        form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" ||
        decoded(header).alg !== "RS256" ||
        !signed ||
        said.iss !== fake.serviceAccount ||
        said.aud !== TOKEN_URL ||
        typeof said.scope !== "string"
      )
        return reply(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
      const token = `${fake.tokenPrefix ?? "ya29.fake-"}${issued.size + 1}`;
      issued.add(token);
      return reply(200, { access_token: token, expires_in: 3599, token_type: "Bearer" });
    }

    const bearer = (init.headers.Authorization ?? "").replace(/^Bearer /, "");
    if (!issued.has(bearer))
      return refuse(401, "UNAUTHENTICATED", `Request had invalid credentials ${bearer}`);
    if (fake.apiDisabledIn !== undefined)
      return refuse(403, "PERMISSION_DENIED", "API Keys API has not been used", [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "SERVICE_DISABLED",
          metadata: { consumer: `projects/${fake.apiDisabledIn}` },
        },
      ]);
    const world = fake.world.load();
    const shown = ({ value: _value, purged: _purged, ...key }: FakeGoogleKey) => ({
      uid: `uid-${key.name.split("/").at(-1)}`,
      createTime: "2026-11-01T00:00:00Z",
      ...key,
    });

    if (pathname === "/v2/keys:lookupKey" && init.method === "GET") {
      const key = world.keys.find((k) => k.value === searchParams.get("keyString"));
      const project = key?.name.split("/")[1];
      if (!key || project === undefined) return refuse(400, "INVALID_ARGUMENT", "Invalid API key");
      if (!fake.projects.includes(project))
        return refuse(403, "PERMISSION_DENIED", "Permission 'apikeys.keys.lookup' denied");
      return reply(200, {
        parent: `projects/${project}`,
        ...(key.purged ? {} : { name: key.name }),
      });
    }

    const operation = /^\/v2\/(operations\/[^/]+)$/.exec(pathname);
    if (operation && init.method === "GET") {
      const found = world.operations.find((o) => o.name === operation[1]);
      if (!found) return refuse(404, "NOT_FOUND", "operation not found");
      if (found.polls > 0) {
        fake.world.save({
          ...world,
          operations: world.operations.map((o) => (o === found ? { ...o, polls: o.polls - 1 } : o)),
        });
        return reply(200, { name: found.name, done: false });
      }
      return reply(200, finished(found.name, found.response, fake.failOperation));
    }

    const [, parent = "", project = "", id, keyString] = KEYS.exec(pathname) ?? [];
    if (!parent) return refuse(404, "NOT_FOUND", "not found");
    if (!fake.projects.includes(project))
      return refuse(403, "PERMISSION_DENIED", `Permission denied on project ${project}`);
    const name = id === undefined ? "" : `${parent}/${id}`;
    const key = world.keys.find((k) => k.name === name && !k.purged);

    if (id === undefined && init.method === "POST") {
      if (fake.failCreate !== undefined)
        return refuse(fake.failCreate, "INTERNAL", `refused ${init.headers.Authorization}`);
      const keyId = searchParams.get("keyId") ?? `uuid-${world.created + 1}`;
      if (!/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(keyId))
        return refuse(400, "INVALID_ARGUMENT", "invalid keyId");
      if (world.keys.some((k) => k.name === `${parent}/${keyId}`))
        return refuse(409, "ALREADY_EXISTS", "key exists");
      const asked = parseObject(init.body ?? "{}");
      const made = world.created + 1;
      const added: FakeGoogleKey = {
        name: `${parent}/${keyId}`,
        value: `${fake.valuePrefix}${made}x`,
        ...(typeof asked.displayName === "string" ? { displayName: asked.displayName } : {}),
        ...(isRecord(asked.restrictions) ? { restrictions: asked.restrictions } : {}),
      };
      const response = {
        "@type": "type.googleapis.com/google.api.apikeys.v2.Key",
        ...shown(added),
        ...(fake.noKeyString ? {} : { keyString: added.value }),
      };
      const op = `operations/akmf.p7-create-${made}`;
      fake.world.save({
        keys: fake.failOperation ? world.keys : [...world.keys, added],
        created: made,
        operations: [...world.operations, { name: op, polls: fake.pendingPolls ?? 0, response }],
      });
      fake.effect(
        `google create ${added.name}${added.displayName ? ` "${added.displayName}"` : ""}${added.restrictions ? ` with ${JSON.stringify(added.restrictions)}` : ""}`,
      );
      if (fake.loseCreated) throw new TypeError("fetch failed");
      return reply(
        200,
        fake.pendingPolls ? { name: op } : finished(op, response, fake.failOperation),
      );
    }
    if (!key) return refuse(404, "NOT_FOUND", `key ${name} not found`);
    if (init.method === "GET" && keyString) return reply(200, { keyString: key.value });
    if (init.method === "GET") return reply(200, shown(key));
    if (init.method !== "DELETE") return refuse(405, "UNIMPLEMENTED", "method not allowed");
    if (key.deleteTime) return refuse(400, "FAILED_PRECONDITION", "key is already deleted");
    const gone = { ...key, deleteTime: "2026-11-17T12:00:00Z" };
    const op = `operations/akmf.p7-delete-${world.operations.length + 1}`;
    fake.world.save({
      ...world,
      keys: world.keys.map((k) => (k === key ? gone : k)),
      operations: [...world.operations, { name: op, polls: 0, response: shown(gone) }],
    });
    fake.effect(`google delete ${key.name}`);
    return reply(200, finished(op, shown(gone)));
  };
}

function finished(name: string, response: Record<string, unknown>, failed = false) {
  return failed
    ? { name, done: true, error: { code: 9, message: "failed" } }
    : { name, done: true, response };
}

export function memoryWorld(keys: FakeGoogleKey[] = []) {
  let world: GoogleWorld = { keys: [...keys], created: 0, operations: [] };
  return { load: () => world, save: (next: GoogleWorld) => void (world = next) };
}
