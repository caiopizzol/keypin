import type { SecretspecAt } from "@keypin/core";
import type { DopplerRef } from "./reference";

const URI = /^doppler(\+[^:]*)?:\/\/([^/?#]*)([^?#]*)(.*)$/is;
const SHAPE = "doppler://<project>, or doppler://<project>/<config>";
const SLUG = /^[a-z0-9_-]+$/;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED = ["DOPPLER_PROJECT", "DOPPLER_CONFIG", "DOPPLER_ENVIRONMENT"];
const NAMES = "lowercase letters, digits, - and _";

export function locate({ uri, profile, key, ref }: SecretspecAt): DopplerRef | string {
  const [, variant, project = "", path = "", rest = ""] = URI.exec(uri) ?? [];
  if (variant !== undefined)
    return `uses ${uri}; keypin doesn't read doppler${variant}:// providers, so write ${SHAPE}`;
  if (rest || project.includes("@") || project.includes(":"))
    return `uses ${uri}; a doppler:// provider takes only a project and a config, so write ${SHAPE}`;
  if (!SLUG.test(project))
    return `uses ${uri}, whose project isn't a Doppler project name, which uses only ${NAMES}; write ${SHAPE}`;
  const pinned = path.replace(/^\/+|\/+$/g, "");
  if (pinned && !SLUG.test(pinned))
    return `uses ${uri}, whose config isn't one Doppler config name, which uses only ${NAMES}; write ${SHAPE}`;
  const item = itemOf(ref);
  if (typeof item !== "string" && item !== null) return item.problem;
  const slash = item?.indexOf("/") ?? -1;
  const config = item !== null && slash !== -1 ? item.slice(0, slash) : pinned || profile;
  const name = item === null ? key : item.slice(slash + 1);
  if (!SLUG.test(config))
    return `the config "${config}" isn't a Doppler config name, which uses only ${NAMES}; name the config in the provider, such as doppler://${project}/<config>`;
  if (!SECRET_NAME.test(name))
    return `"${name}" isn't a Doppler secret name, which uses only uppercase letters, digits and _, not starting with a digit`;
  if (RESERVED.includes(name)) return `Doppler reserves the secret name ${name} for itself`;
  return { kind: "doppler", project, config, name };
}

function itemOf(ref: SecretspecAt["ref"]): string | null | { problem: string } {
  if (ref === null) return null;
  const unknown = Object.keys(ref).find((field) => field !== "item");
  if (unknown !== undefined)
    return {
      problem: `field "ref" has the field "${unknown}"; a Doppler ref has only item, such as { item = "<config>/<NAME>" }`,
    };
  const item = ref.item;
  return typeof item === "string" && item.trim()
    ? item
    : { problem: `field "ref" needs item, the secret's name, with its config before it` };
}
