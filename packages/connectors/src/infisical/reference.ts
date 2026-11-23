import { isRecord } from "@keypin/core";

export type InfisicalRef = {
  kind: "infisical";
  url: string;
  project: string;
  environment: string;
  path: string;
  name: string;
};

export type InfisicalReference = Omit<InfisicalRef, "url">;

export type InfisicalPlace = Pick<InfisicalRef, "url">;

export type InfisicalScope = Omit<InfisicalRef, "name">;

export const SCHEME = "infisical://";

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

export function account(place: InfisicalPlace): string {
  return `Infisical at ${place.url}`;
}

export function describe(ref: InfisicalRef): string {
  return `${format(ref)} (${account(ref)})`;
}

export function decode(value: unknown): InfisicalRef | null {
  if (!isRecord(value) || value.kind !== "infisical") return null;
  const { url, project, environment, path, name } = value;
  if (
    typeof url !== "string" ||
    typeof project !== "string" ||
    typeof environment !== "string" ||
    typeof path !== "string" ||
    typeof name !== "string"
  )
    return null;
  return { kind: "infisical", url, project, environment, path, name };
}

export function decodeScope(value: unknown): InfisicalScope | null {
  if (!isRecord(value) || value.kind !== "infisical") return null;
  const { url, project, environment, path } = value;
  if (
    typeof url !== "string" ||
    typeof project !== "string" ||
    typeof environment !== "string" ||
    typeof path !== "string"
  )
    return null;
  return { kind: "infisical", url, project, environment, path };
}
