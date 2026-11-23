import { isRecord, type TableReader } from "@keypin/core";

export type SecretsManagerRef = {
  kind: "awssm";
  account: string;
  region: string;
  name: string;
  field: string | null;
};

export type SecretsManagerReference = Omit<SecretsManagerRef, "account">;

export type SecretsManagerPin = Pick<SecretsManagerRef, "account">;

export type SecretsManagerScope = Pick<SecretsManagerRef, "kind" | "account" | "region">;

export const SCHEME = "awssm://";
const SHAPE =
  "must be awssm://<region>/<secret name>, with :<JSON key> after the name to read one key of a JSON secret";
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;
const FIELD = /^[A-Za-z0-9_.:/=+@-]{1,100}$/;
const ACCOUNT = /^\d{12}$/;

export function parse(rest: string): SecretsManagerReference | string {
  if (rest.startsWith("arn:"))
    return `${SHAPE}; keypin reads secrets by name in the account pinned under [awssm], not by ARN`;
  const at = rest.indexOf("/");
  const region = rest.slice(0, at);
  const after = rest.slice(at + 1);
  const colon = after.indexOf(":");
  const name = colon < 0 ? after : after.slice(0, colon);
  const field = colon < 0 ? null : after.slice(colon + 1);
  if (at < 0 || !REGION.test(region) || !NAME.test(name) || (field !== null && !FIELD.test(field)))
    return SHAPE;
  return { kind: "awssm", region, name, field };
}

export function format(ref: SecretsManagerReference): string {
  return `${SCHEME}${ref.region}/${ref.name}${ref.field === null ? "" : `:${ref.field}`}`;
}

export function account(place: Omit<SecretsManagerScope, "kind">): string {
  return `AWS account ${place.account} in ${place.region}`;
}

export function describe(ref: SecretsManagerRef): string {
  return `${format(ref)} (${account(ref)})`;
}

export function readPin(read: TableReader): SecretsManagerPin | undefined {
  read.only(["account"]);
  const value = read.filledIn(
    read.required("account"),
    "account",
    "your AWS account ID, the 12 digits aws sts get-caller-identity shows",
  );
  if (value === undefined) return undefined;
  if (!ACCOUNT.test(value)) {
    read.fail(`field "account" must be your AWS account ID, 12 digits such as "123456789012"`);
    return undefined;
  }
  return { account: value };
}

export function decode(value: unknown): SecretsManagerRef | null {
  if (!isRecord(value) || value.kind !== "awssm") return null;
  const { account: id, region, name, field } = value;
  if (
    typeof id !== "string" ||
    typeof region !== "string" ||
    typeof name !== "string" ||
    (field !== null && typeof field !== "string")
  )
    return null;
  return { kind: "awssm", account: id, region, name, field };
}

export function decodeScope(value: unknown): SecretsManagerScope | null {
  if (!isRecord(value) || value.kind !== "awssm") return null;
  const { account: id, region } = value;
  if (typeof id !== "string" || typeof region !== "string") return null;
  return { kind: "awssm", account: id, region };
}
