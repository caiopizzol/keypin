import { isRecord, type TableReader } from "@keypin/core";

export type DopplerRef = {
  kind: "doppler";
  workplace: string;
  project: string;
  config: string;
  name: string;
};

export type DopplerReference = Omit<DopplerRef, "workplace">;

export type DopplerPin = Pick<DopplerRef, "workplace">;

export type DopplerScope = Omit<DopplerRef, "name">;

export const SCHEME = "doppler://";

export function parse(rest: string): DopplerReference | string {
  const [project = "", config = "", ...name] = rest.split("/");
  if (!project.trim() || !config.trim() || !name.join("/").trim())
    return `must be ${SCHEME}<project>/<config>/<SECRET_NAME>`;
  return { kind: "doppler", project, config, name: name.join("/") };
}

export function format(ref: DopplerReference): string {
  return `${SCHEME}${ref.project}/${ref.config}/${ref.name}`;
}

export function account(place: DopplerPin): string {
  return `Doppler workplace ${place.workplace}`;
}

export function describe(ref: DopplerRef): string {
  return `${format(ref)} (${account(ref)})`;
}

export function readPin(read: TableReader): DopplerPin | undefined {
  read.only(["workplace"]);
  const workplace = read.filledIn(
    read.required("workplace"),
    "workplace",
    "your Doppler workplace's slug, from the dashboard's address after /workplace/, or from doppler me",
  );
  return workplace === undefined ? undefined : { workplace };
}

export function decode(value: unknown): DopplerRef | null {
  if (!isRecord(value) || value.kind !== "doppler") return null;
  const { workplace, project, config, name } = value;
  if (
    typeof workplace !== "string" ||
    typeof project !== "string" ||
    typeof config !== "string" ||
    typeof name !== "string"
  )
    return null;
  return { kind: "doppler", workplace, project, config, name };
}

export function decodeScope(value: unknown): DopplerScope | null {
  if (!isRecord(value) || value.kind !== "doppler") return null;
  const { workplace, project, config } = value;
  if (typeof workplace !== "string" || typeof project !== "string" || typeof config !== "string")
    return null;
  return { kind: "doppler", workplace, project, config };
}
