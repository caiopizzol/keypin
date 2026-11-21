import { type Fetch, parseObject } from "@keypin/core";
import { TOKEN_URL } from "./auth";
import { fakePrivateKey, refuse, reply, token, type TokenSigner } from "./testing-auth";

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
