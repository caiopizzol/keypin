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

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const refuse = (status: number, code: string, message: string, details: unknown[] = []) =>
  reply(status, { error: { code: status, message, status: code, details } });

interface TokenSigner {
  serviceAccount: string;
  privateKey: string;
  tokenPrefix?: string;
}

function token(fake: TokenSigner, body: string | undefined, issued: Set<string>): Response {
  const form = new URLSearchParams(body ?? "");
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
  const value = `${fake.tokenPrefix ?? "ya29.fake-"}${issued.size + 1}`;
  issued.add(value);
  return reply(200, { access_token: value, expires_in: 3599, token_type: "Bearer" });
}

export function googleFetch(fake: FakeGoogle): Fetch {
  const issued = new Set<string>();

  return async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    if (url === TOKEN_URL) return token(fake, init.body, issued);

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

export interface FakeIamKey {
  id: string;
  type?: "USER_MANAGED" | "SYSTEM_MANAGED";
  origin?: "GOOGLE_PROVIDED" | "USER_PROVIDED";
  disabled?: boolean;
  created?: string;
  made?: boolean;
}

export interface FakeIamAccount {
  email: string;
  project: string;
  keys: FakeIamKey[];
}

export interface IamWorld {
  accounts: FakeIamAccount[];
  created: number;
}

export interface FakeIam extends TokenSigner {
  manages: readonly string[];
  keyPrefix: string;
  apiDisabledIn?: string;
  policy?: string;
  unready?: number;
  failCreate?: number;
  failDelete?: boolean;
  loseCreated?: boolean;
  world: { load(): IamWorld; save(world: IamWorld): void };
  effect(line: string): void;
}

const IAM_KEYS =
  /^\/v1\/projects\/([^/]+)\/serviceAccounts\/([^/]+)\/keys(?:\/([0-9a-f]+)(:disable)?)?$/;

export function serviceAccountKeyId(n: number): string {
  return n.toString(16).padStart(40, "a");
}

export function iamKeyFile(email: string, project: string, id: string, privateKey: string): string {
  return JSON.stringify({
    type: "service_account",
    project_id: project,
    private_key_id: id,
    private_key: privateKey,
    client_email: email,
    client_id: "100000000000000000001",
    token_uri: TOKEN_URL,
  });
}

export function iamFetch(fake: FakeIam): Fetch {
  const issued = new Set<string>();
  let unready = 0;
  let madePem: string | undefined;
  const madeKey = () => (madePem ??= fakePrivateKey());
  const signer = (body: string | undefined): TokenSigner => {
    const [header, claims] = (new URLSearchParams(body ?? "").get("assertion") ?? "")
      .split(".")
      .map((part) => parseObject(Buffer.from(part, "base64url").toString()));
    const email = claims?.iss;
    if (typeof email !== "string") return fake;
    const made = fake.world
      .load()
      .accounts.find((a) => a.email === email)
      ?.keys.some((k) => k.id === header?.kid && k.made && !k.disabled);
    return made ? { serviceAccount: email, privateKey: madeKey() } : fake;
  };
  return async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    if (url === TOKEN_URL) {
      const by = signer(init.body);
      if (by === fake) return token(fake, init.body, issued);
      if (unready > 0) {
        unready--;
        return reply(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
      }
      return token(by, init.body, new Set());
    }
    const bearer = (init.headers.Authorization ?? "").replace(/^Bearer /, "");
    if (!issued.has(bearer))
      return refuse(401, "UNAUTHENTICATED", `Request had invalid credentials ${bearer}`);
    if (fake.apiDisabledIn !== undefined)
      return refuse(403, "PERMISSION_DENIED", "IAM API has not been used", [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "SERVICE_DISABLED",
          metadata: { consumer: `projects/${fake.apiDisabledIn}` },
        },
      ]);
    const [, project = "", email = "", id, disable] = IAM_KEYS.exec(pathname) ?? [];
    if (!email) return refuse(404, "NOT_FOUND", "not found");
    if (!fake.manages.includes(email))
      return refuse(403, "PERMISSION_DENIED", `Permission denied on ${email}`);
    const world = fake.world.load();
    const account = world.accounts.find(
      (a) => a.email === email && (project === "-" || project === a.project),
    );
    if (!account) return refuse(404, "NOT_FOUND", `Unknown service account ${email}`);
    const nameOf = (keyId: string) =>
      `projects/${account.project}/serviceAccounts/${email}/keys/${keyId}`;
    const shown = (key: FakeIamKey) => ({
      name: nameOf(key.id),
      validAfterTime: key.created ?? "2026-08-01T00:00:00Z",
      validBeforeTime: "9999-12-31T23:59:59Z",
      keyAlgorithm: "KEY_ALG_RSA_2048",
      keyOrigin: key.origin ?? "GOOGLE_PROVIDED",
      keyType: key.type ?? "USER_MANAGED",
      ...(key.disabled ? { disabled: true } : {}),
    });
    const save = (keys: FakeIamKey[], created = world.created) =>
      fake.world.save({
        accounts: world.accounts.map((a) => (a === account ? { ...a, keys } : a)),
        created,
      });

    if (id === undefined && init.method === "GET") {
      const types = searchParams.getAll("keyTypes");
      const keys = account.keys.filter(
        (k) => !types.length || types.includes(k.type ?? "USER_MANAGED"),
      );
      return reply(200, keys.length ? { keys: keys.map(shown) } : {});
    }
    if (id === undefined && init.method === "POST") {
      if (fake.failCreate !== undefined)
        return refuse(fake.failCreate, "INTERNAL", `refused ${init.headers.Authorization}`);
      if (fake.policy !== undefined)
        return refuse(
          400,
          "FAILED_PRECONDITION",
          "Key creation is not allowed on this service account.",
          [
            {
              "@type": "type.googleapis.com/google.rpc.PreconditionFailure",
              violations: [
                {
                  type: `constraints/${fake.policy}`,
                  subject: `projects/${account.project}?configvalue=${email}`,
                  description: "Key creation is not allowed on this service account.",
                },
              ],
            },
          ],
        );
      if (account.keys.filter((k) => (k.type ?? "USER_MANAGED") === "USER_MANAGED").length >= 10)
        return refuse(429, "RESOURCE_EXHAUSTED", "Maximum number of keys on account reached.");
      const made = world.created + 1;
      const key: FakeIamKey = {
        id: serviceAccountKeyId(made),
        created: "2026-11-18T12:00:00Z",
        made: true,
      };
      save([...account.keys, key], made);
      unready = fake.unready ?? 0;
      fake.effect(`google-iam create ${email}/${key.id}`);
      if (fake.loseCreated) throw new TypeError("fetch failed");
      const pem = `${fake.keyPrefix}${made}\n${madeKey()}`;
      const file = iamKeyFile(email, account.project, key.id, pem);
      return reply(200, {
        ...shown(key),
        privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE",
        privateKeyData: Buffer.from(file).toString("base64"),
      });
    }
    const key = account.keys.find((k) => k.id === id);
    if (!key) return refuse(404, "NOT_FOUND", `Service account key ${id} does not exist.`);
    if (init.method === "GET" && !disable) return reply(200, shown(key));
    if (init.method === "POST" && disable) {
      save(account.keys.map((k) => (k === key ? { ...k, disabled: true } : k)));
      return reply(200, {});
    }
    if (init.method === "DELETE" && !disable) {
      if (fake.failDelete) return refuse(500, "INTERNAL", "internal error");
      save(account.keys.filter((k) => k !== key));
      fake.effect(`google-iam delete ${email}/${key.id}`);
      return reply(200, {});
    }
    return refuse(405, "UNIMPLEMENTED", "method not allowed");
  };
}

export function memoryIamWorld(accounts: FakeIamAccount[]) {
  let world: IamWorld = { accounts: structuredClone(accounts), created: 0 };
  return { load: () => world, save: (next: IamWorld) => void (world = next) };
}
