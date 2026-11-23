import { isRecord } from "@keypin/core";

export type BitwardenRef = {
  kind: "bitwarden";
  url: string;
  project: string;
  name: string;
};

export type BitwardenReference = Omit<BitwardenRef, "url">;

export type BitwardenPlace = Pick<BitwardenRef, "url">;

export type BitwardenScope = Omit<BitwardenRef, "name">;

export const SCHEME = "bitwarden://";
export const US_CLOUD = "https://vault.bitwarden.com";
const EU_CLOUD = "https://vault.bitwarden.eu";
const CLOUDS: Readonly<Record<string, { api: string; identity: string }>> = {
  [US_CLOUD]: { api: "https://api.bitwarden.com", identity: "https://identity.bitwarden.com" },
  [EU_CLOUD]: { api: "https://api.bitwarden.eu", identity: "https://identity.bitwarden.eu" },
};
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function endpoints(url: string): { api: string; identity: string } {
  return CLOUDS[url] ?? { api: `${url}/api`, identity: `${url}/identity` };
}

export function parse(rest: string): BitwardenReference | string {
  const slash = rest.indexOf("/");
  const project = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  if (slash === -1 || !project.trim() || !name.trim())
    return `must be ${SCHEME}<project>/<SECRET_NAME>, with the project's name or ID`;
  return { kind: "bitwarden", project, name };
}

export function format(ref: BitwardenReference): string {
  return `${SCHEME}${ref.project}/${ref.name}`;
}

export function account(place: BitwardenPlace): string {
  return `Bitwarden at ${place.url}`;
}

export function describe(ref: BitwardenRef): string {
  return `${format(ref)} (${account(ref)})`;
}

export function decode(value: unknown): BitwardenRef | null {
  if (!isRecord(value) || value.kind !== "bitwarden") return null;
  const { url, project, name } = value;
  if (typeof url !== "string" || typeof project !== "string" || typeof name !== "string")
    return null;
  return { kind: "bitwarden", url, project, name };
}

export function decodeScope(value: unknown): BitwardenScope | null {
  if (!isRecord(value) || value.kind !== "bitwarden") return null;
  const { url, project } = value;
  if (typeof url !== "string" || typeof project !== "string") return null;
  return { kind: "bitwarden", url, project };
}
