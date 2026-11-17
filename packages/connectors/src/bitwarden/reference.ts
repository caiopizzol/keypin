import { isRecord, type TableReader } from "@keypin/core";

export type BitwardenRef = {
  kind: "bitwarden";
  url: string;
  organization: string;
  project: string;
  name: string;
};

export type BitwardenReference = Omit<BitwardenRef, "url" | "organization">;

export type BitwardenPin = Pick<BitwardenRef, "url" | "organization">;

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

export function account(place: BitwardenPin): string {
  return `Bitwarden organization ${place.organization} at ${place.url}`;
}

export function describe(ref: BitwardenRef): string {
  return `${format(ref)} (${account(ref)})`;
}

export function readPin(read: TableReader): BitwardenPin | undefined {
  read.only(["url", "organization"]);
  const url = read.filledIn(
    read.optional("url"),
    "url",
    `your Bitwarden server's address, such as ${EU_CLOUD}`,
  );
  const organization = read.filledIn(
    read.required("organization"),
    "organization",
    "your Bitwarden organization's ID, from the address bar in Secrets Manager",
  );
  const origin = url === undefined ? US_CLOUD : httpsOrigin(url);
  if (origin === null) {
    read.fail(`field "url" must be an https:// address such as ${EU_CLOUD}, with no path`);
    return undefined;
  }
  if (organization === undefined) return undefined;
  if (!UUID.test(organization)) {
    read.fail(
      `field "organization" must be your organization's ID, such as 2f1d6c9e-8a3b-4c5d-9e7f-0a1b2c3d4e5f, from the address bar in Secrets Manager`,
    );
    return undefined;
  }
  return { url: origin, organization: organization.toLowerCase() };
}

function httpsOrigin(text: string): string | null {
  if (!/^https:\/\/[^/?#\\]+\/?$/.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function decode(value: unknown): BitwardenRef | null {
  if (!isRecord(value) || value.kind !== "bitwarden") return null;
  const { url, organization, project, name } = value;
  if (
    typeof url !== "string" ||
    typeof organization !== "string" ||
    typeof project !== "string" ||
    typeof name !== "string"
  )
    return null;
  return { kind: "bitwarden", url, organization, project, name };
}

export function decodeScope(value: unknown): BitwardenScope | null {
  if (!isRecord(value) || value.kind !== "bitwarden") return null;
  const { url, organization, project } = value;
  if (typeof url !== "string" || typeof organization !== "string" || typeof project !== "string")
    return null;
  return { kind: "bitwarden", url, organization, project };
}
