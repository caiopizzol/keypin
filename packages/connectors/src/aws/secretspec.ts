import type { SecretspecAt } from "@keypin/core";
import { FIELD, NAME, REGION, type SecretsManagerRef } from "./reference";

const URI = /^awssm(\+[^:]*)?:\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/is;
const SHAPE = "awssm://<region>, such as awssm://us-east-1";

export function locate({
  uri,
  project,
  profile,
  key,
  ref,
}: SecretspecAt): SecretsManagerRef | string {
  const [, variant, host = "", path = "", query = "", fragment] = URI.exec(uri) ?? [];
  if (variant !== undefined)
    return `uses ${uri}; keypin doesn't read awssm${variant}:// providers, so write ${SHAPE}`;
  if (host.includes("@"))
    return `uses ${uri}, which names an AWS profile; keypin signs in only with the credentials in its environment, so drop the profile from the provider and set AWS_PROFILE where keypin runs`;
  if (!REGION.test(host))
    return `uses ${uri}, which doesn't name a region, so CI and the console can't find the secret; write ${SHAPE}`;
  if (path.replace(/^\/+/, "") || fragment !== undefined)
    return `uses ${uri}; an awssm:// provider takes no path, so write ${SHAPE}, and name the secret with ref = { item = "..." }`;
  const place = { kind: "awssm" as const, region: host };
  if (ref === null) {
    const prefix = new URLSearchParams(query).get("prefix");
    const own = `secretspec/${project}/${profile}/${key}`;
    const name = prefix === null ? own : `${prefix.replace(/\/+$/, "")}/${own}`;
    if (!NAME.test(name))
      return `secretspec's name for this secret, ${name}, isn't an AWS secret name keypin reads; give the secret a ref = { item = "<secret name>" }`;
    return { ...place, name, field: null };
  }
  const unknown = Object.keys(ref).find((field) => field !== "item" && field !== "field");
  if (unknown !== undefined)
    return `field "ref" has the field "${unknown}"; an AWS Secrets Manager ref has item and field`;
  const { item, field = null } = ref;
  if (typeof item !== "string" || !item.trim()) return `field "ref" needs item, the secret's name`;
  if (item.startsWith("arn:"))
    return `field "ref" names the secret by ARN; keypin reads secrets by name, so write the name after secret: without its 6-character suffix`;
  if (!NAME.test(item)) return `field "ref" has item "${item}", which isn't an AWS secret name`;
  if (field !== null && (typeof field !== "string" || !FIELD.test(field)))
    return `field "ref" has a field keypin can't read; it names one key of a JSON secret, such as field = "password"`;
  return { ...place, name: item, field };
}
