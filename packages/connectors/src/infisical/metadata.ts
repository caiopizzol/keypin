import { type Day, isRecord } from "@keypin/core";
import type { Json } from "./response";

export const ROTATED = "rotated";

interface Metadata {
  key: string;
  value: string;
  isEncrypted?: boolean;
}

export function metadataOf(secret: Json): Metadata[] {
  const list = secret.secretMetadata;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): Metadata[] =>
    isRecord(entry) && typeof entry.key === "string"
      ? [
          {
            key: entry.key,
            value: typeof entry.value === "string" ? entry.value : "",
            ...(typeof entry.isEncrypted === "boolean" ? { isEncrypted: entry.isEncrypted } : {}),
          },
        ]
      : [],
  );
}

export function withRotated(metadata: Metadata[], rotated: Day | undefined): Metadata[] {
  if (rotated === undefined) return metadata;
  return [
    ...metadata.filter((entry) => entry.key !== ROTATED),
    { key: ROTATED, value: rotated, isEncrypted: true },
  ];
}
