import { type Fetch, isRecord } from "@keypin/core";
import { IAM, REGION, STS } from "./api";
import { signing } from "./sigv4";

export interface FakeAwsKey {
  id: string;
  secret: string;
  user: string | null;
  path?: string;
  status?: "Active" | "Inactive";
  created?: string;
  account?: string;
}

export interface AwsWorld {
  keys: FakeAwsKey[];
  created: number;
}

export interface FakeAws {
  account: string;
  idPrefix: string;
  valuePrefix: string;
  denied?: readonly string[];
  unready?: number;
  failCreate?: number;
  failDelete?: boolean;
  loseCreated?: boolean;
  world: { load(): AwsWorld; save(world: AwsWorld): void };
  effect(line: string): void;
}

const AUTH =
  /^AWS4-HMAC-SHA256 Credential=([A-Z0-9]+)\/(\d{8})\/([a-z0-9-]+)\/([a-z]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/;

export function accessKeyJson(id: string, secret: string, user = "keypin-admin"): string {
  return JSON.stringify(
    {
      AccessKey: {
        UserName: user,
        AccessKeyId: id,
        Status: "Active",
        SecretAccessKey: secret,
        CreateDate: "2026-11-01T00:00:00+00:00",
      },
    },
    null,
    4,
  );
}

export function awsFetch(fake: FakeAws): Fetch {
  let unready = 0;
  const fresh = new Set<string>();
  const xml = (status: number, body: string) =>
    new Response(body, { status, headers: { "Content-Type": "text/xml" } });
  const error = (status: number, code: string, message: string) =>
    xml(
      status,
      `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error><RequestId>req-1</RequestId></ErrorResponse>`,
    );
  const ok = (action: string, result: string) =>
    xml(
      200,
      `<${action}Response><${action}Result>${result}</${action}Result><ResponseMetadata><RequestId>req-1</RequestId></ResponseMetadata></${action}Response>`,
    );

  return async (url, init) => {
    const service = url === IAM ? "iam" : url === STS ? "sts" : null;
    if (service === null || init.method !== "POST")
      return error(404, "NotFound", "no such endpoint");
    const world = fake.world.load();
    const checked = verify(url, init, service, REGION, world.keys);
    if ("refused" in checked) return error(checked.status, checked.refused, checked.message);
    const signer = checked.signer;
    if (fresh.has(signer.id) && unready > 0) {
      unready--;
      return error(
        403,
        "InvalidClientTokenId",
        "The security token included in the request is invalid.",
      );
    }
    const form = new URLSearchParams(init.body ?? "");
    const action = form.get("Action") ?? "";
    const account = signer.account ?? fake.account;
    const arn =
      signer.user === null
        ? `arn:aws:iam::${account}:root`
        : `arn:aws:iam::${account}:user${signer.path ?? "/"}${signer.user}`;

    if (service === "sts") {
      if (action !== "GetCallerIdentity" || form.get("Version") !== "2011-06-15")
        return error(400, "InvalidAction", "unknown action");
      return ok(
        action,
        `<Arn>${arn}</Arn><UserId>AIDAFAKE${signer.user ?? "ROOT"}</UserId><Account>${account}</Account>`,
      );
    }
    if (form.get("Version") !== "2010-05-08") return error(400, "InvalidAction", "wrong version");
    if (fake.denied?.includes(action))
      return error(403, "AccessDenied", `User: ${arn} is not authorized to perform: iam:${action}`);
    const user = form.get("UserName");
    if (user === null) return error(400, "MissingParameter", "keypin always passes UserName");
    const owned = world.keys.filter(
      (k) => k.user === user && (k.account ?? fake.account) === account,
    );
    const shown = (k: FakeAwsKey) =>
      `<member><UserName>${user}</UserName><AccessKeyId>${k.id}</AccessKeyId><Status>${k.status ?? "Active"}</Status><CreateDate>${k.created ?? "2026-11-01T00:00:00Z"}</CreateDate></member>`;

    if (action === "ListAccessKeys")
      return ok(
        action,
        `<UserName>${user}</UserName><AccessKeyMetadata>${owned.map(shown).join("")}</AccessKeyMetadata><IsTruncated>false</IsTruncated>`,
      );

    if (action === "CreateAccessKey") {
      if (fake.failCreate !== undefined)
        return error(
          fake.failCreate,
          "ServiceFailure",
          `refused for ${init.headers.Authorization}`,
        );
      if (owned.length >= 2)
        return error(409, "LimitExceeded", `Cannot exceed quota for AccessKeysPerUser: 2`);
      const made = world.created + 1;
      const key: FakeAwsKey = {
        id: `${fake.idPrefix}${String(made).padStart(20 - fake.idPrefix.length, "0")}`,
        secret: `${fake.valuePrefix}${made}x`,
        user,
        created: "2026-11-17T12:00:00Z",
        ...(signer.account === undefined ? {} : { account: signer.account }),
      };
      fake.world.save({ keys: [...world.keys, key], created: made });
      fresh.add(key.id);
      unready = fake.unready ?? 0;
      fake.effect(`aws create ${user}/${key.id}`);
      if (fake.loseCreated) throw new TypeError("fetch failed");
      return ok(
        action,
        `<AccessKey><UserName>${user}</UserName><AccessKeyId>${key.id}</AccessKeyId><Status>Active</Status><SecretAccessKey>${key.secret}</SecretAccessKey></AccessKey>`,
      );
    }

    const target = owned.find((k) => k.id === form.get("AccessKeyId"));
    if (!target)
      return error(
        404,
        "NoSuchEntity",
        `The Access Key with id ${form.get("AccessKeyId")} cannot be found.`,
      );
    if (action === "UpdateAccessKey") {
      const status = form.get("Status");
      if (status !== "Active" && status !== "Inactive")
        return error(400, "ValidationError", "bad status");
      if ((target.status ?? "Active") !== status) {
        fake.world.save({
          ...world,
          keys: world.keys.map((k) => (k === target ? { ...k, status } : k)),
        });
      }
      return ok(action, "");
    }
    if (action === "DeleteAccessKey") {
      if (fake.failDelete) return error(500, "ServiceFailure", "try again");
      fake.world.save({ ...world, keys: world.keys.filter((k) => k !== target) });
      fake.effect(`aws delete ${user}/${target.id}`);
      return ok(action, "");
    }
    return error(400, "InvalidAction", "unknown action");
  };
}

interface Signer {
  id: string;
  secret: string;
  token?: string;
  status?: "Active" | "Inactive";
}

type Verified<K> = { signer: K } | { refused: string; status: number; message: string };

function verify<K extends Signer>(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  service: string,
  region: string,
  keys: readonly K[],
): Verified<K> {
  const auth = AUTH.exec(init.headers.Authorization ?? "");
  const date = init.headers["X-Amz-Date"] ?? "";
  if (!auth || auth[3] !== region || auth[4] !== service || auth[2] !== date.slice(0, 8))
    return {
      refused: "IncompleteSignature",
      status: 400,
      message: "the request isn't signed for this service",
    };
  const signer = keys.find((k) => k.id === auth[1]);
  const token = init.headers["X-Amz-Security-Token"];
  if (!signer || signer.status === "Inactive" || token !== signer.token)
    return {
      refused: "InvalidClientTokenId",
      status: 403,
      message: "The security token included in the request is invalid.",
    };
  const headers = Object.fromEntries(
    Object.entries(init.headers).filter(
      ([name]) =>
        !["authorization", "x-amz-date", "x-amz-security-token"].includes(name.toLowerCase()),
    ),
  );
  const expected = signing(
    { method: "POST", url, headers, body: init.body ?? "" },
    { id: signer.id, secret: signer.secret, ...(token === undefined ? {} : { token }) },
    { region, service },
    new Date(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
    ),
  );
  if (expected.signature !== auth[6])
    return {
      refused: "SignatureDoesNotMatch",
      status: 403,
      message: "The request signature we calculated does not match.",
    };
  return { signer };
}

export function memoryWorld(keys: FakeAwsKey[] = []) {
  let world: AwsWorld = { keys: [...keys], created: 0 };
  return { load: () => world, save: (next: AwsWorld) => void (world = next) };
}

export interface FakeAwsCredentials {
  id: string;
  secret: string;
  token?: string;
  account?: string;
  expired?: boolean;
}

export interface FakeAwsSecret {
  value: string | null;
  created?: string;
  tags?: Record<string, string>;
  rotation?: boolean;
  owner?: string;
  deleted?: boolean;
  version?: string;
  versions?: Record<string, string>;
  previous?: string | null;
}

export interface FakeSecretsManager {
  account: string;
  credentials: FakeAwsCredentials[];
  secrets: Record<string, FakeAwsSecret>;
  denied?: readonly string[];
  failPut?: number;
  staleReads?: "current" | "current-and-new-versions";
}

export interface SecretsStore {
  load(): Record<string, FakeAwsSecret>;
  save(key: string, secret: FakeAwsSecret): void;
  effect(line: string): void;
}

const SM_HOST = /^https:\/\/(secretsmanager|sts)\.([a-z0-9-]+)\.amazonaws\.com\/$/;

export function secretsManagerFetch(fake: FakeSecretsManager, store: SecretsStore): Fetch {
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/x-amz-json-1.1" },
    });
  const fail = (status: number, type: string, message: string) =>
    reply(status, { __type: `com.amazonaws.secretsmanager#${type}`, Message: message });
  const xml = (status: number, body: string) =>
    new Response(body, { status, headers: { "Content-Type": "text/xml" } });
  const stsError = (status: number, code: string, message: string) =>
    xml(
      status,
      `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>`,
    );
  const seconds = (iso: string) => Date.parse(iso) / 1000;

  return async (url, init) => {
    const host = SM_HOST.exec(url);
    if (!host || init.method !== "POST") return fail(404, "NotFound", "no such endpoint");
    const [, service = "", region = ""] = host;
    const keys = fake.credentials.map((c) => ({ ...c, status: "Active" as const }));
    const checked = verify(url, init, service, region, keys);
    const account = "signer" in checked ? (checked.signer.account ?? fake.account) : "";
    if (service === "sts") {
      if ("refused" in checked) return stsError(checked.status, checked.refused, checked.message);
      if (checked.signer.expired)
        return stsError(
          403,
          "ExpiredToken",
          "The security token included in the request is expired",
        );
      const form = new URLSearchParams(init.body ?? "");
      if (form.get("Action") !== "GetCallerIdentity")
        return stsError(400, "InvalidAction", "unknown action");
      return xml(
        200,
        `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::${account}:user/app</Arn><UserId>AIDAFAKE</UserId><Account>${account}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`,
      );
    }
    if ("refused" in checked)
      return fail(
        checked.status,
        checked.refused.replace(/^Invalid/, "UnrecognizedClient"),
        checked.message,
      );
    const target = init.headers["X-Amz-Target"] ?? "";
    const action = target.startsWith("secretsmanager.") ? target.slice(15) : "";
    if (init.headers["Content-Type"] !== "application/x-amz-json-1.1")
      return fail(400, "SerializationException", "wrong content type");
    if (fake.denied?.includes(action))
      return fail(
        400,
        "AccessDeniedException",
        `not authorized to perform secretsmanager:${action}`,
      );
    const body: unknown = JSON.parse(init.body ?? "{}");
    const params = isRecord(body) ? body : {};
    const secrets = { ...fake.secrets, ...store.load() };
    if (action === "ListSecrets") {
      const listed = Object.entries(secrets)
        .filter(([key, secret]) => key.startsWith(`${region}/`) && !secret.deleted)
        .map(([key, secret]) => ({
          ARN: arnOf(region, account, key),
          Name: key.slice(region.length + 1),
          LastChangedDate: seconds(secret.created ?? "2026-11-01T00:00:00Z"),
          Tags: Object.entries(secret.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
        }));
      return reply(200, { SecretList: listed });
    }
    const name = typeof params.SecretId === "string" ? params.SecretId : "";
    const key = `${region}/${name}`;
    const secret = secrets[key];
    if (!secret || (secret.deleted && action !== "DescribeSecret"))
      return fail(
        400,
        "ResourceNotFoundException",
        "Secrets Manager can't find the specified secret.",
      );
    const arn = arnOf(region, account, key);
    const version = secret.version ?? `v-${secret.created ?? "first"}`;
    const created = seconds(secret.created ?? "2026-11-01T00:00:00Z");
    if (action === "DescribeSecret")
      return reply(200, {
        ARN: arn,
        Name: name,
        LastChangedDate: created,
        Tags: Object.entries(secret.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
        VersionIdsToStages: { [version]: ["AWSCURRENT"] },
        ...(secret.rotation ? { RotationEnabled: true } : {}),
        ...(secret.owner ? { OwningService: secret.owner } : {}),
        ...(secret.deleted ? { DeletedDate: created } : {}),
      });
    if (action === "GetSecretValue") {
      const asked = typeof params.VersionId === "string" ? params.VersionId : null;
      const stale = fake.staleReads !== undefined && secret.previous !== undefined;
      const value =
        asked === null
          ? stale
            ? secret.previous
            : secret.value
          : fake.staleReads === "current-and-new-versions"
            ? undefined
            : secret.versions?.[asked];
      if (value === undefined)
        return fail(
          400,
          "ResourceNotFoundException",
          "Secrets Manager can't find the specified secret value for VersionId",
        );
      return reply(200, {
        ARN: arn,
        Name: name,
        VersionId: asked ?? version,
        CreatedDate: created,
        ...(value === null ? { SecretBinary: "AAEC" } : { SecretString: value }),
      });
    }
    if (action === "ListSecretVersionIds")
      return reply(200, {
        ARN: arn,
        Name: name,
        Versions: [
          { VersionId: "v-old", VersionStages: ["AWSPREVIOUS"], CreatedDate: created - 86400 * 90 },
          { VersionId: version, VersionStages: ["AWSCURRENT"], CreatedDate: created },
        ],
      });
    if (action === "PutSecretValue") {
      const token = params.ClientRequestToken;
      if (typeof token !== "string" || token.length < 32)
        return fail(
          400,
          "InvalidParameterException",
          "ClientRequestToken must be 32 to 64 characters",
        );
      if (typeof params.SecretString !== "string")
        return fail(400, "InvalidParameterException", "keypin always sends SecretString");
      if (fake.failPut !== undefined)
        return fail(fake.failPut, "InternalServiceError", "try again");
      const date = init.headers["X-Amz-Date"] ?? "";
      const at = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`;
      store.save(key, {
        ...secret,
        value: params.SecretString,
        created: at,
        version: token,
        versions: { ...secret.versions, [token]: params.SecretString },
        previous: secret.value,
      });
      store.effect(`awssm put ${key}`);
      return reply(200, {
        ARN: arn,
        Name: name,
        VersionId: token,
        VersionStages: ["AWSCURRENT"],
      });
    }
    if (action === "TagResource") {
      const tags = Array.isArray(params.Tags) ? params.Tags.filter(isRecord) : [];
      const added = Object.fromEntries(tags.map((tag) => [String(tag.Key), String(tag.Value)]));
      store.save(key, { ...secret, tags: { ...secret.tags, ...added } });
      return reply(200, {});
    }
    return fail(400, "InvalidAction", `no action ${action}`);
  };
}

function arnOf(region: string, account: string, key: string): string {
  return `arn:aws:secretsmanager:${region}:${account}:secret:${key.slice(region.length + 1)}-AbCdEf`;
}

export function memorySecrets() {
  const saved: Record<string, FakeAwsSecret> = {};
  const effects: string[] = [];
  return {
    load: () => saved,
    save: (key: string, secret: FakeAwsSecret) => void (saved[key] = secret),
    effect: (line: string) => void effects.push(line),
    effects,
  };
}

export function fileSecrets(
  read: () => string | null,
  write: (text: string) => void,
  effect: (line: string) => void,
): SecretsStore {
  const load = (): Record<string, FakeAwsSecret> => {
    try {
      const parsed: unknown = JSON.parse(read() ?? "{}");
      return isRecord(parsed)
        ? Object.fromEntries(
            Object.entries(parsed).filter((entry): entry is [string, FakeAwsSecret] =>
              isFakeSecret(entry[1]),
            ),
          )
        : {};
    } catch {
      return {};
    }
  };
  return {
    load,
    save: (key, secret) => write(JSON.stringify({ ...load(), [key]: secret })),
    effect,
  };
}

function isFakeSecret(value: unknown): value is FakeAwsSecret {
  return isRecord(value) && (typeof value.value === "string" || value.value === null);
}
