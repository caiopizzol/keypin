import { isRecord } from "@keypin/core";

export type DopplerRef = {
  kind: "doppler";
  project: string;
  config: string;
  name: string;
};

export type DopplerScope = Omit<DopplerRef, "name">;

export const SCHEME = "doppler://";

export function parse(rest: string): DopplerRef | string {
  const [project = "", config = "", ...name] = rest.split("/");
  if (!project.trim() || !config.trim() || !name.join("/").trim())
    return `must be ${SCHEME}<project>/<config>/<SECRET_NAME>`;
  return { kind: "doppler", project, config, name: name.join("/") };
}

export function format(ref: DopplerRef): string {
  return `${SCHEME}${ref.project}/${ref.config}/${ref.name}`;
}

export function account(): string {
  return "Doppler";
}

export function describe(ref: DopplerRef): string {
  return `${format(ref)} (${account()})`;
}

export function decode(value: unknown): DopplerRef | null {
  if (!isRecord(value) || value.kind !== "doppler") return null;
  const { project, config, name } = value;
  if (typeof project !== "string" || typeof config !== "string" || typeof name !== "string")
    return null;
  return { kind: "doppler", project, config, name };
}

export function decodeScope(value: unknown): DopplerScope | null {
  if (!isRecord(value) || value.kind !== "doppler") return null;
  const { project, config } = value;
  if (typeof project !== "string" || typeof config !== "string") return null;
  return { kind: "doppler", project, config };
}
