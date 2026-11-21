import { type Fetch, isRecord } from "@keypin/core";
import { verify } from "./testing-signature";

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

export const WEB_IDENTITY_EXPIRATION = "2026-11-20T12:15:00Z";

export interface FakeWebIdentity {
  role: string;
  jwt: string;
  minted: FakeAwsCredentials;
}

export interface FakeSecretsManager {
  account: string;
  credentials: FakeAwsCredentials[];
  webIdentity?: FakeWebIdentity;
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
  const minted: FakeAwsCredentials[] = [];
  const assumeRole = (form: URLSearchParams) => {
    const given = fake.webIdentity;
    if (!given || form.get("Version") !== "2011-06-15")
      return stsError(400, "InvalidAction", "unknown action");
    if (form.get("WebIdentityToken") !== given.jwt)
      return stsError(400, "InvalidIdentityToken", "Incorrect token audience");
    if (form.get("RoleArn") !== given.role)
      return stsError(
        403,
        "AccessDenied",
        "Not authorized to perform sts:AssumeRoleWithWebIdentity",
      );
    const credentials = given.minted;
    minted.push(credentials);
    return xml(
      200,
      `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><SessionToken>${credentials.token ?? ""}</SessionToken><SecretAccessKey>${credentials.secret}</SecretAccessKey><Expiration>${WEB_IDENTITY_EXPIRATION}</Expiration><AccessKeyId>${credentials.id}</AccessKeyId></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
    );
  };

  return async (url, init) => {
    const host = SM_HOST.exec(url);
    if (!host || init.method !== "POST") return fail(404, "NotFound", "no such endpoint");
    const [, service = "", region = ""] = host;
    const form = new URLSearchParams(init.body ?? "");
    if (service === "sts" && form.get("Action") === "AssumeRoleWithWebIdentity")
      return assumeRole(form);
    const keys = [...fake.credentials, ...minted].map((c) => ({
      ...c,
      status: "Active" as const,
    }));
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
