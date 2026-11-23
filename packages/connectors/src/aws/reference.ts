import { isRecord } from "@keypin/core";

export type SecretsManagerRef = {
  kind: "awssm";
  region: string;
  name: string;
  field: string | null;
};

export type SecretsManagerScope = Pick<SecretsManagerRef, "kind" | "region">;

export const SCHEME = "awssm://";
const SHAPE = `must be ${SCHEME}<region>/<secret name>, with :<JSON key> after the name to read one key of a JSON secret`;
export const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
export const NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;
export const FIELD = /^[A-Za-z0-9_.:/=+@-]{1,100}$/;

export function parse(rest: string): SecretsManagerRef | string {
  if (rest.startsWith("arn:")) return `${SHAPE}; keypin reads secrets by name, not by ARN`;
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

export function format(ref: SecretsManagerRef): string {
  return `${SCHEME}${ref.region}/${ref.name}${ref.field === null ? "" : `:${ref.field}`}`;
}

export function account(place: Omit<SecretsManagerScope, "kind">): string {
  return `AWS in ${place.region}`;
}

export function describe(ref: SecretsManagerRef): string {
  return `${format(ref)} (${account(ref)})`;
}

export function decode(value: unknown): SecretsManagerRef | null {
  if (!isRecord(value) || value.kind !== "awssm") return null;
  const { region, name, field } = value;
  if (
    typeof region !== "string" ||
    typeof name !== "string" ||
    (field !== null && typeof field !== "string")
  )
    return null;
  return { kind: "awssm", region, name, field };
}

export function decodeScope(value: unknown): SecretsManagerScope | null {
  if (!isRecord(value) || value.kind !== "awssm") return null;
  const { region } = value;
  if (typeof region !== "string") return null;
  return { kind: "awssm", region };
}
