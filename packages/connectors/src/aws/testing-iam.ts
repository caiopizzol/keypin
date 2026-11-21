import type { Fetch } from "@keypin/core";
import { IAM, REGION, STS } from "./api";
import { verify } from "./testing-signature";

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

export function memoryWorld(keys: FakeAwsKey[] = []) {
  let world: AwsWorld = { keys: [...keys], created: 0 };
  return { load: () => world, save: (next: AwsWorld) => void (world = next) };
}
