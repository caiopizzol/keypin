import { isRecord } from "./record";

export interface Files {
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export async function writeJsonAtomic(files: Files, path: string, data: unknown): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await files.write(temporary, `${JSON.stringify(data, null, 2)}\n`);
  await files.rename(temporary, path);
}

export async function readVersionedJson(
  files: Files,
  path: string,
  versions: readonly number[],
  what: string,
): Promise<Record<string, unknown> | null> {
  const text = await files.read(path);
  if (text === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path}: the ${what} isn't valid JSON`);
  }
  if (!isRecord(data)) throw new Error(`${path}: the ${what} must be a JSON object`);
  if (!versions.some((version) => version === data.version)) {
    throw new Error(
      `${path}: the ${what} has schema version ${JSON.stringify(data.version ?? null)}, and this keypin reads version ${versions.join(" or ")}`,
    );
  }
  return data;
}
