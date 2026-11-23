import type { SecretspecAt } from "@keypin/core";
import { type BitwardenRef, US_CLOUD, UUID } from "./reference";

const URI = /^bws(\+[^:]*)?:\/\/([^/?#]*)(.*)$/is;
const SHAPE = "bws://<project ID>, or bws://<server>@<project ID>";
const NOT_READ = ["field", "section", "vault", "version"];

export const PASSWORD_MANAGER =
  "keypin's Bitwarden vault is Secrets Manager, not the Password Manager, so write bws://<project ID>";

export function locate({ uri, key, ref }: SecretspecAt): BitwardenRef | string {
  const [, variant, authority = "", rest = ""] = URI.exec(uri) ?? [];
  if (variant !== undefined)
    return `uses ${uri}; keypin doesn't read bws${variant}:// providers, so write ${SHAPE}`;
  if (rest !== "" && rest !== "/")
    return `uses ${uri}, which names more than a project; write ${SHAPE}, and name the secret with ref = { item = "..." }`;
  const at = authority.lastIndexOf("@");
  const server = authority.slice(0, Math.max(at, 0));
  const project = authority.slice(at + 1);
  if (!UUID.test(project))
    return `uses ${uri}, which doesn't name a project ID; write ${SHAPE}, with the ID from the project's page in Secrets Manager`;
  const url = server ? origin(server) : US_CLOUD;
  if (url === null) return `uses ${uri}, whose server keypin can't read; write ${SHAPE}`;
  const place = { kind: "bitwarden" as const, url, project: project.toLowerCase() };
  if (ref === null) return { ...place, name: key };
  const refused = NOT_READ.find((field) => ref[field] !== undefined);
  if (refused !== undefined)
    return `field "ref" names ${refused}; a Bitwarden Secrets Manager ref has only item, the secret's name`;
  const unknown = Object.keys(ref).find((field) => field !== "item");
  if (unknown !== undefined)
    return `field "ref" has the unknown field "${unknown}"; a Bitwarden Secrets Manager ref has only item`;
  const item = ref.item;
  if (typeof item !== "string" || !item.trim()) return `field "ref" needs item, the secret's name`;
  return { ...place, name: item };
}

function origin(server: string): string | null {
  if (server.includes("\\")) return null;
  try {
    const url = new URL(`https://${server}/`);
    return url.pathname === "/" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}
