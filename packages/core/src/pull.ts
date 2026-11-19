import type { TableReader } from "./destination";

export interface PullReader {
  readonly by: string;
  readonly [field: string]: string | undefined;
}

export interface PullKind<T extends PullReader = PullReader> {
  readonly kind: T["by"];
  readonly label: string;
  readonly destination: string;
  parse(read: TableReader): T | undefined;
  id(reader: T): string;
  describe(reader: T): string;
}

export type PullKinds = readonly PullKind[];

export function pullKindOf(kinds: PullKinds, by: string): PullKind {
  const kind = kinds.find((k) => k.kind === by);
  if (!kind) throw new Error(`keypin has no pull kind "${by}"`);
  return kind;
}

export function pullPlace(reader: PullReader, kinds: PullKinds): string {
  const kind = pullKindOf(kinds, reader.by);
  return `${kind.destination}:${kind.id(reader)}`;
}

export function pullName(reader: PullReader, kinds: PullKinds): string {
  const kind = pullKindOf(kinds, reader.by);
  return `${kind.label} ${kind.describe(reader)}`;
}
