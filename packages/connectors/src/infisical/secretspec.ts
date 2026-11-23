import type { SecretspecAt } from "@keypin/core";
import type { InfisicalRef } from "./reference";

const URI = /^infisical(\+[^:]*)?:\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/is;
const SHAPE = "infisical://<host>/<project ID>";
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FOLDER_NAME = /^[A-Za-z0-9_-]+$/;
const DEFAULT_PATH = "/secretspec";

export function locate({ uri, project, profile, key, ref }: SecretspecAt): InfisicalRef | string {
  const [, variant, host = "", path = "", query = "", fragment] = URI.exec(uri) ?? [];
  if (variant !== undefined)
    return `uses ${uri}; keypin doesn't read infisical${variant}:// providers, so write ${SHAPE}`;
  if (fragment !== undefined) return `uses ${uri}, which has a #; write ${SHAPE}`;
  if (!host)
    return `uses ${uri}, which doesn't name the Infisical server, so CI and the console can't find it; write ${SHAPE}, such as infisical://app.infisical.com/<project ID>`;
  const url = origin(host);
  if (url === null) return `uses ${uri}, whose host keypin can't read; write ${SHAPE}`;
  const id = path.replace(/^\/+|\/+$/g, "");
  if (!PROJECT_ID.test(id))
    return `uses ${uri}, which doesn't name a project ID; write ${SHAPE}, with the ID from the project's settings`;
  const options = new URLSearchParams(query);
  const tls = options.get("tls");
  if (tls !== null && tls !== "true" && tls !== "1")
    return `uses ${uri}; keypin signs in to Infisical only over https, so remove tls=${tls}`;
  const prefix = folderPrefix(options.get("path"));
  const environment = options.get("env") || profile;
  const place = { kind: "infisical" as const, url, project: id, environment };
  if (ref === null) {
    const unnamed = [project, profile].find((name) => !FOLDER_NAME.test(name));
    if (unnamed !== undefined)
      return `"${unnamed}" can't name an Infisical folder, which uses only letters, digits, - and _; rename it, or give the secret a ref = { item = "/<folder>/<NAME>" }`;
    return { ...place, path: join(prefix, `${project}/${profile}`), name: key };
  }
  if (ref.version !== undefined)
    return `field "ref" names a version, which secretspec only reads; keypin rotates the secret, so remove version`;
  const unknown = Object.keys(ref).find((field) => field !== "item");
  if (unknown !== undefined)
    return `field "ref" has the field "${unknown}"; an Infisical ref has only item, such as { item = "/<folder>/<NAME>" }`;
  const item = ref.item;
  if (typeof item !== "string" || !item.trim())
    return `field "ref" needs item, the secret's name, with its folder before it`;
  const slash = item.lastIndexOf("/");
  const name = item.slice(slash + 1);
  if (!name) return `field "ref" names the folder ${item}; add the secret's name after it`;
  if (slash === -1) return { ...place, path: prefix, name };
  const folder = item.slice(0, slash).replace(/\/+$/, "");
  const at = folder === "" ? "/" : folder.startsWith("/") ? folder : join(prefix, folder);
  return { ...place, path: at, name };
}

function folderPrefix(given: string | null): string {
  if (!given) return DEFAULT_PATH;
  const trimmed = given.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function join(left: string, right: string): string {
  return `${left.replace(/\/+$/, "")}/${right.replace(/^\/+/, "")}`;
}

function origin(host: string): string | null {
  if (host.includes("@") || host.includes("\\")) return null;
  try {
    const url = new URL(`https://${host}/`);
    return url.pathname === "/" ? url.origin : null;
  } catch {
    return null;
  }
}
