import { randomUUID } from "node:crypto";
import {
  type Day,
  type Fetch,
  type IdToken,
  isRecord,
  type KeyRef,
  localDay,
  messageOf,
  NoIdToken,
  parseDay,
  parseObject,
  Secret,
  SignInFailed,
  type SignInReason,
  type VaultBackend,
  type VaultItem,
  type VaultScope,
  WriteRefused,
} from "@keypin/core";
import { json, type JsonReply, query, returned, text, unsignedQuery } from "./api";
import { ANOTHER_WAY, type AwsSignIn, ROLE_ARN } from "./credentials";
import type { Credentials } from "./sigv4";
import {
  account,
  decode,
  decodeScope,
  describe as describeRef,
  type SecretsManagerRef as Ref,
  type SecretsManagerScope as Scope,
} from "./reference";
import { hidden, problem, refusedSignIn } from "./secrets-manager-problems";
import {
  dateOf,
  type Fail,
  fieldOf,
  type Json,
  plain,
  refused,
  tagsOf,
} from "./secrets-manager-values";

const SERVICE = "secretsmanager";
export const ROTATED_TAG = "keypin-rotated:";
const CURRENT = "AWSCURRENT";
const OIDC_SESSION_SECONDS = "900";
const REFRESH_MARGIN_MS = 60_000;

interface Session {
  credentials: Credentials;
  expires: number | null;
}

export interface SecretsManagerOptions {
  fetch?: Fetch;
  now?: () => Date;
  requestToken?: () => string;
  idToken?: IdToken;
}

export function secretsManagerBackend(
  signIn: AwsSignIn,
  options: SecretsManagerOptions = {},
): VaultBackend {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const requestToken = options.requestToken ?? randomUUID;
  const sessions = new Map<string, Promise<Session>>();
  const versionSaved = new Map<string, string>();
  const secretKey = (ref: Ref) => `${ref.region}/${ref.name}`;

  async function signedIn(place: Scope): Promise<Session> {
    const where = account(place);
    if ("problem" in signIn)
      throw new SignInFailed(`${where}: sign-in failed: ${signIn.problem}`, signIn.reason);
    const { credentials, source, expires } =
      "role" in signIn
        ? { ...(await assumed(place, signIn)), source: `the role in ${ROLE_ARN}` }
        : { ...signIn, expires: null };
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
    return { credentials, expires };
  }

  async function assumed(
    place: Scope,
    { role, audience }: { role: string; audience: string },
  ): Promise<Session> {
    const failed = (why: string, reason: SignInReason = { kind: "other" }) =>
      new SignInFailed(`${account(place)}: sign-in failed: ${why}`, reason);
    const idToken =
      options.idToken ??
      (() => Promise.reject(new NoIdToken("keypin has no way to ask for an OIDC token here")));
    let jwt: string;
    try {
      jwt = await idToken(audience);
    } catch (error) {
      throw error instanceof NoIdToken
        ? failed(`${ROLE_ARN} is set, but ${error.message}, ${ANOTHER_WAY}`, {
            kind: "no-credentials",
          })
        : failed(`couldn't get GitHub Actions' OIDC token: ${messageOf(error)}`);
    }
    const reply = await unsignedQuery(
      fetch,
      "sts",
      "AssumeRoleWithWebIdentity",
      {
        RoleArn: role,
        RoleSessionName: `keypin-${randomUUID()}`,
        WebIdentityToken: jwt,
        DurationSeconds: OIDC_SESSION_SECONDS,
      },
      place.region,
    );
    if (reply.status !== 200) {
      const message = text(reply.xml, "Message");
      const said = `${returned("AssumeRoleWithWebIdentity", reply)}${message ? `: ${message}` : ""}`;
      throw failed(
        `AWS STS refused GitHub's OIDC token for the role ${role} (${hidden(said, jwt)}); keypin asked GitHub for a token for the audience ${audience}, so check that the role's trust policy allows that audience and this job's subject`,
      );
    }
    const id = text(reply.xml, "AccessKeyId");
    const secret = text(reply.xml, "SecretAccessKey");
    const token = text(reply.xml, "SessionToken");
    const expires = Date.parse(text(reply.xml, "Expiration") ?? "");
    if (!id || !secret || !token || !Number.isFinite(expires))
      throw failed("AWS's AssumeRoleWithWebIdentity reply has no credentials");
    return { credentials: { id, secret, token }, expires };
  }

  async function session(place: Scope): Promise<Credentials> {
    const key = place.region;
    const pending = sessions.get(key);
    if (pending) {
      const current = await pending;
      if (current.expires === null || current.expires - now().getTime() > REFRESH_MARGIN_MS)
        return current.credentials;
    }
    let next = sessions.get(key);
    if (!next || next === pending) {
      const started = signedIn(place);
      sessions.set(key, started);
      if ("role" in signIn)
        started.catch(() => {
          if (sessions.get(key) === started) sessions.delete(key);
        });
      next = started;
    }
    return (await next).credentials;
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
    const version = versionSaved.get(secretKey(ref));
    const found = await call(ref, "GetSecretValue", {
      SecretId: ref.name,
      ...(version ? { VersionId: version } : {}),
    });
    if (version && found.code === "ResourceNotFoundException")
      throw fail(
        `${describeRef(ref)}: keypin saved this secret a moment ago, but Secrets Manager doesn't return that version yet`,
      );
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
        `${describeRef(ref)}: Secrets Manager rotates this secret itself; turn its rotation off before keypin rotates the key, or drop the key's issuer from secretspec.toml`,
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
      const versionId = requestToken();
      const put = await call(ref, "PutSecretValue", {
        SecretId: ref.name,
        SecretString: next,
        ClientRequestToken: versionId,
      });
      if (put.status >= 400 && put.status < 500)
        throw new WriteRefused(`${describeRef(ref)}: ${problem(ref, "PutSecretValue", put)}`);
      if (put.status !== 200)
        throw new Error(`${describeRef(ref)}: ${returned("PutSecretValue", put)}`);
      versionSaved.set(secretKey(ref), versionId);
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
