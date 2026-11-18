import { randomUUID } from "node:crypto";
import {
  type Day,
  type Fetch,
  isRecord,
  type KeyRef,
  localDay,
  parseDay,
  parseObject,
  Secret,
  SignInFailed,
  type VaultBackend,
  type VaultItem,
  type VaultScope,
  WriteRefused,
} from "@keypin/core";
import { json, type JsonReply, query, returned, text } from "./api";
import { type AwsSignIn, KEY_ID } from "./credentials";
import type { Credentials } from "./sigv4";
import {
  account,
  decode,
  decodeScope,
  describe as describeRef,
  type SecretsManagerRef as Ref,
  type SecretsManagerScope as Scope,
} from "./reference";

const SERVICE = "secretsmanager";
export const ROTATED_TAG = "keypin-rotated:";
const CURRENT = "AWSCURRENT";

type Json = Record<string, unknown>;

export interface SecretsManagerOptions {
  fetch?: Fetch;
  now?: () => Date;
  requestToken?: () => string;
}

export function secretsManagerBackend(
  signIn: AwsSignIn,
  options: SecretsManagerOptions = {},
): VaultBackend {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const requestToken = options.requestToken ?? randomUUID;
  const sessions = new Map<string, Promise<Credentials>>();

  async function signedIn(place: Scope): Promise<Credentials> {
    const where = account(place);
    if ("problem" in signIn)
      throw new SignInFailed(`${where}: sign-in failed: ${signIn.problem}`, signIn.reason);
    const { credentials, source } = signIn;
    const reply = await query(
      fetch,
      "sts",
      credentials,
      "GetCallerIdentity",
      {},
      now(),
      place.region,
    );
    if (reply.status !== 200)
      throw new SignInFailed(`${where}: sign-in failed: ${refusedSignIn(reply, source)}`, {
        kind: "other",
      });
    const actual = text(reply.xml, "Account");
    if (actual === null)
      throw new SignInFailed(
        `${where}: sign-in failed: AWS's GetCallerIdentity reply has no account`,
        { kind: "other" },
      );
    if (actual !== place.account)
      throw new SignInFailed(
        `${where}: sign-in failed: ${source} belongs to AWS account ${actual}, but keypin.toml pins ${place.account}`,
        { kind: "wrong-account", pinned: place.account, actual },
      );
    return credentials;
  }

  function session(place: Scope): Promise<Credentials> {
    const key = `${place.account}/${place.region}`;
    let pending = sessions.get(key);
    if (!pending) {
      pending = signedIn(place);
      sessions.set(key, pending);
    }
    return pending;
  }

  async function call(place: Scope, action: string, params: Json): Promise<JsonReply> {
    const credentials = await session(place);
    return json(fetch, SERVICE, credentials, place.region, action, params, now());
  }

  async function described(ref: Ref, fail: Fail = plain): Promise<Json> {
    const found = await call(ref, "DescribeSecret", { SecretId: ref.name });
    if (found.status !== 200 || typeof found.body.ARN !== "string")
      throw fail(`${describeRef(ref)}: ${problem(ref, "DescribeSecret", found)}`);
    if (found.body.DeletedDate !== undefined)
      throw fail(`${describeRef(ref)}: the secret is scheduled for deletion`);
    return found.body;
  }

  async function current(ref: Ref, fail: Fail = plain): Promise<{ text: string; arn: string }> {
    const found = await call(ref, "GetSecretValue", { SecretId: ref.name });
    if (found.status !== 200 || typeof found.body.ARN !== "string")
      throw fail(`${describeRef(ref)}: ${problem(ref, "GetSecretValue", found)}`);
    const value = found.body.SecretString;
    if (typeof value !== "string")
      throw fail(`${describeRef(ref)}: the secret holds binary data; keypin reads a secret's text`);
    return { text: value, arn: found.body.ARN };
  }

  async function valueOf(ref: Ref) {
    const found = await current(ref);
    const value = ref.field === null ? found.text : fieldOf(ref, found.text, plain);
    if (value === "") throw new Error(`${describeRef(ref)}: the value is empty`);
    return { secret: new Secret(value), ids: { vault: ref.region, item: found.arn } };
  }

  async function writable(ref: Ref, fail: Fail): Promise<string | null> {
    const details = await described(ref, fail);
    if (typeof details.OwningService === "string")
      throw fail(
        `${describeRef(ref)}: ${details.OwningService} manages this secret, so keypin leaves its value to it`,
      );
    if (details.RotationEnabled === true)
      throw fail(
        `${describeRef(ref)}: Secrets Manager rotates this secret itself; turn its rotation off before keypin rotates the key, or drop the key's issuer from keypin.toml`,
      );
    if (ref.field === null) return null;
    const found = await current(ref, fail);
    fieldOf(ref, found.text, fail);
    return found.text;
  }

  return {
    async read(given) {
      return (await valueOf(own(given))).secret;
    },

    async readItem(given) {
      return valueOf(own(given));
    },

    async itemIds(given) {
      const ref = own(given);
      const details = await described(ref);
      return { vault: ref.region, item: String(details.ARN) };
    },

    async write(given, value, options = {}) {
      const ref = own(given);
      if (options.newItem)
        throw new WriteRefused(
          `${describeRef(ref)}: keypin doesn't create AWS secrets; create it with aws secretsmanager create-secret, then run this again`,
        );
      const before = await writable(ref, refused);
      const next =
        before === null
          ? value.reveal()
          : JSON.stringify({ ...parseObject(before), [ref.field ?? ""]: value.reveal() });
      const put = await call(ref, "PutSecretValue", {
        SecretId: ref.name,
        SecretString: next,
        ClientRequestToken: requestToken(),
      });
      if (put.status >= 400 && put.status < 500)
        throw new WriteRefused(`${describeRef(ref)}: ${problem(ref, "PutSecretValue", put)}`);
      if (put.status !== 200)
        throw new Error(`${describeRef(ref)}: ${returned("PutSecretValue", put)}`);
      if (ref.field === null || options.rotated === undefined) return;
      await tag(ref, options.rotated);
    },

    async checkWrite(given) {
      await writable(own(given), plain);
    },

    async list(given) {
      const scope = ownScope(given);
      const items: VaultItem[] = [];
      let token: unknown;
      do {
        const found = await call(scope, "ListSecrets", {
          MaxResults: 100,
          ...(typeof token === "string" ? { NextToken: token } : {}),
        });
        if (found.status !== 200 || !Array.isArray(found.body.SecretList))
          throw new Error(
            `${account(scope)}: couldn't list secrets: ${returned("ListSecrets", found)}`,
          );
        for (const entry of found.body.SecretList.filter(isRecord))
          items.push({
            id: String(entry.ARN),
            title: String(entry.Name),
            tags: tagsOf(entry).map((pair) => pair.Key),
            updatedAt: dateOf(entry.LastChangedDate)?.toISOString() ?? "",
          });
        token = found.body.NextToken;
      } while (typeof token === "string");
      return items;
    },

    async metadata(given) {
      const ref = own(given);
      const details = await described(ref);
      if (ref.field !== null) {
        const key = `${ROTATED_TAG}${ref.field}`;
        const value = tagsOf(details).find((pair) => pair.Key === key)?.Value ?? "";
        if (value === "") return { rotated: null };
        const rotated = parseDay(value);
        if (!rotated)
          throw new Error(
            `${describeRef(ref)}: the tag ${key} isn't a YYYY-MM-DD date: "${value}"`,
          );
        return { rotated };
      }
      return { rotated: await currentVersionDay(ref) };
    },
  };

  async function currentVersionDay(ref: Ref): Promise<Day | null> {
    let token: unknown;
    do {
      const found = await call(ref, "ListSecretVersionIds", {
        SecretId: ref.name,
        ...(typeof token === "string" ? { NextToken: token } : {}),
      });
      if (found.status !== 200 || !Array.isArray(found.body.Versions))
        throw new Error(`${describeRef(ref)}: ${problem(ref, "ListSecretVersionIds", found)}`);
      const version = found.body.Versions.filter(isRecord).find(
        (entry) => Array.isArray(entry.VersionStages) && entry.VersionStages.includes(CURRENT),
      );
      const created = version && dateOf(version.CreatedDate);
      if (created) return localDay(created);
      token = found.body.NextToken;
    } while (typeof token === "string");
    return null;
  }

  async function tag(ref: Ref, rotated: Day): Promise<void> {
    const key = `${ROTATED_TAG}${ref.field}`;
    const tagged = await call(ref, "TagResource", {
      SecretId: ref.name,
      Tags: [{ Key: key, Value: rotated }],
    });
    if (tagged.status !== 200)
      throw new Error(
        `${describeRef(ref)}: keypin saved the new value, but couldn't set the tag ${key} to ${rotated} (${returned("TagResource", tagged)}); set it by hand, and give keypin secretsmanager:TagResource`,
      );
  }
}

type Fail = (message: string) => Error;
const plain: Fail = (message) => new Error(message);
const refused: Fail = (message) => new WriteRefused(message);

function fieldOf(ref: Ref, value: string, fail: Fail): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed))
    throw fail(
      `${describeRef(ref)}: the secret isn't a JSON object, so it has no key ${ref.field}`,
    );
  const found = parsed[ref.field ?? ""];
  if (found === undefined)
    throw fail(`${describeRef(ref)}: the secret's JSON has no key ${ref.field}`);
  if (typeof found !== "string")
    throw fail(`${describeRef(ref)}: the JSON key ${ref.field} holds a ${typeof found}, not text`);
  return found;
}

function tagsOf(entry: Json): { Key: string; Value: string }[] {
  return Array.isArray(entry.Tags)
    ? entry.Tags.flatMap((pair) =>
        isRecord(pair) && typeof pair.Key === "string"
          ? [{ Key: pair.Key, Value: typeof pair.Value === "string" ? pair.Value : "" }]
          : [],
      )
    : [];
}

function dateOf(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;
}

function problem(ref: Ref, action: string, reply: JsonReply): string {
  const said = returned(action, reply);
  if (reply.code === "ResourceNotFoundException")
    return `no secret ${ref.name} in ${ref.region} (${said}); check the region and the name`;
  if (reply.code === "AccessDeniedException")
    return `the signed-in identity isn't allowed secretsmanager:${action} on the secret, or its KMS key (${said})`;
  if (reply.code === "DecryptionFailure" || reply.code === "EncryptionFailure")
    return `the signed-in identity can't use the secret's KMS key (${said})`;
  return said;
}

function refusedSignIn(reply: { status: number; code: string | null }, source: string): string {
  const said = returned("GetCallerIdentity", reply);
  if (reply.code === "ExpiredToken")
    return `the temporary credentials in ${source} expired (${said}); get new ones`;
  if (reply.code === "SignatureDoesNotMatch")
    return `the secret access key in ${source} doesn't match its key ID, or this computer's clock is off (${said})`;
  if (reply.code === "InvalidClientTokenId")
    return `AWS doesn't accept ${source}: the key was deleted or deactivated, or ${KEY_ID} isn't a key ID (${said})`;
  return said;
}

function own(ref: KeyRef): Ref {
  const mine = decode(ref);
  if (!mine)
    throw new Error(
      `keypin's AWS Secrets Manager vault can't read this reference, which is for ${ref.kind}`,
    );
  return mine;
}

function ownScope(scope: VaultScope): Scope {
  const mine = decodeScope(scope);
  if (!mine) throw new Error(`keypin's AWS Secrets Manager vault can't list ${scope.kind} items`);
  return mine;
}
