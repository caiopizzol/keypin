import { objectField, parseObject, type Secret } from "@keypin/core";
import type { Credentials } from "./sigv4";

export const ACCESS_KEY_ID = /^AKIA[A-Z0-9]{16}$/;
export const TEMPORARY_KEY_ID = /^ASIA[A-Z0-9]{16}$/;

export interface Refusal {
  facts: string;
  reason: string;
  fix: string;
}

export const ADMIN_FIX =
  "put the JSON that aws iam create-access-key --user-name <admin user> prints in the admin item, for an IAM user allowed to list, create, update and delete access keys";

export function adminCredentials(admin: Secret): Credentials | Refusal {
  const json = parseObject(admin.reveal());
  const inner = objectField(json, "AccessKey");
  const key = Object.keys(inner).length ? inner : json;
  const id = key.AccessKeyId;
  const secret = key.SecretAccessKey;
  if (typeof id !== "string" || typeof secret !== "string" || !id || !secret)
    return {
      facts: "the admin item holds no AWS access key JSON",
      reason: "keypin needs the admin key's AccessKeyId and SecretAccessKey, as JSON, in one item",
      fix: ADMIN_FIX,
    };
  if (TEMPORARY_KEY_ID.test(id) || key.SessionToken !== undefined)
    return {
      facts: `the admin item holds temporary credentials ${id}`,
      reason: "temporary credentials expire, so keypin needs a long-term access key of an IAM user",
      fix: ADMIN_FIX,
    };
  if (!ACCESS_KEY_ID.test(id))
    return {
      facts: "the admin item's AccessKeyId isn't an AWS access key ID",
      reason: "an IAM user's access key ID starts with AKIA and has 20 characters",
      fix: ADMIN_FIX,
    };
  return { id, secret };
}
