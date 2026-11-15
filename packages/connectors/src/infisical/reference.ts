import { isRecord, type TableReader } from "@keypin/core";

export type InfisicalRef = {
  kind: "infisical";
  url: string;
  organization: string;
  project: string;
  environment: string;
  path: string;
  name: string;
};

export type InfisicalReference = Omit<InfisicalRef, "url" | "organization">;

export type InfisicalPin = Pick<InfisicalRef, "url" | "organization">;

export type InfisicalScope = Omit<InfisicalRef, "name">;

export const SCHEME = "infisical://";
export const INFISICAL_CLOUD = "https://app.infisical.com";

export function parse(rest: string): InfisicalReference | string {
  const parts = rest.split("/");
  if (parts.length < 3 || parts.some((part) => !part.trim())) {
    return `must be ${SCHEME}<project>/<environment>/<SECRET_NAME>, with any folders before the name`;
  }
  const [project = "", environment = "", ...folders] = parts;
  const name = folders.pop() ?? "";
  return { kind: "infisical", project, environment, path: `/${folders.join("/")}`, name };
}

export function format(ref: InfisicalReference): string {
  const folders = ref.path.split("/").filter(Boolean);
  return `${SCHEME}${[ref.project, ref.environment, ...folders, ref.name].join("/")}`;
}

export function account(place: InfisicalPin): string {
  return `Infisical organization ${place.organization} at ${place.url}`;
}

export function describe(ref: InfisicalRef): string {
  return `${format(ref)} (${account(ref)})`;
}

export function readPin(read: TableReader): InfisicalPin | undefined {
  read.only(["url", "organization"]);
  const url = read.filledIn(
    read.optional("url"),
    "url",
    "your Infisical address, such as https://eu.infisical.com",
  );
  const organization = read.filledIn(
    read.required("organization"),
    "organization",
    "your Infisical organization's slug, from its settings page",
  );
  const origin = url === undefined ? INFISICAL_CLOUD : httpsOrigin(url);
  if (origin === null) {
    read.fail(
      `field "url" must be an https:// address such as https://eu.infisical.com, with no path`,
    );
    return undefined;
  }
  if (organization === undefined) return undefined;
  return { url: origin, organization };
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

export function decode(value: unknown): InfisicalRef | null {
  if (!isRecord(value) || value.kind !== "infisical") return null;
  const { url, organization, project, environment, path, name } = value;
  if (
    typeof url !== "string" ||
    typeof organization !== "string" ||
    typeof project !== "string" ||
    typeof environment !== "string" ||
    typeof path !== "string" ||
    typeof name !== "string"
  )
    return null;
  return { kind: "infisical", url, organization, project, environment, path, name };
}

export function decodeScope(value: unknown): InfisicalScope | null {
  if (!isRecord(value) || value.kind !== "infisical") return null;
  const { url, organization, project, environment, path } = value;
  if (
    typeof url !== "string" ||
    typeof organization !== "string" ||
    typeof project !== "string" ||
    typeof environment !== "string" ||
    typeof path !== "string"
  )
    return null;
  return { kind: "infisical", url, organization, project, environment, path };
}
