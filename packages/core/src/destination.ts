import type { Destination } from "./contracts";

export interface PublishTarget {
  readonly to: string;
  readonly account: string;
  readonly [field: string]: string | undefined;
}

export interface TableReader {
  required(field: string): string | undefined;
  optional(field: string): string | undefined;
  filledIn(value: string | undefined, field: string, what: string): string | undefined;
  only(fields: readonly string[], outdated?: Readonly<Record<string, string>>): void;
  fail(message: string): void;
}

export interface DestinationKind<T extends PublishTarget = PublishTarget, P = unknown> {
  readonly kind: T["to"];
  readonly label: string;
  parse(read: TableReader): T | undefined;
  id(target: T): string;
  secretId(target: T, secretName: string): string;
  checkId(target: T): string;
  fromId(place: string, pinned: string): T | undefined;
  describe(target: T): string;
  named(target: T): string;
  where(target: T): string;
  login(target: T, publisher: P): string;
  refuses?(secretName: string): string | undefined;
  connect(target: T, publisher: P): Destination;
}

export type DestinationKinds = readonly DestinationKind[];

export function kindOf<K extends DestinationKind>(kinds: readonly K[], to: string): K {
  const kind = kinds.find((k) => k.kind === to);
  if (!kind) throw new Error(`keypin has no destination kind "${to}"`);
  return kind;
}

export function connectTo<P>(
  kinds: readonly DestinationKind<PublishTarget, P>[],
  target: PublishTarget,
  publisher: P,
): Destination {
  return kindOf(kinds, target.to).connect(target, publisher);
}

export function placeId(target: PublishTarget, kinds: DestinationKinds): string {
  return `${target.to}:${kindOf(kinds, target.to).id(target)}`;
}

export function destinationId(
  target: PublishTarget,
  secretName: string,
  kinds: DestinationKinds,
): string {
  return `${placeId(target, kinds)}:${secretName}`;
}

export function secretKey(
  target: PublishTarget,
  secretName: string,
  kinds: DestinationKinds,
): string {
  return `${target.to}:${kindOf(kinds, target.to).secretId(target, secretName)}`;
}

export function checkId(target: PublishTarget, kinds: DestinationKinds): string {
  return `${target.to}:${kindOf(kinds, target.to).checkId(target)}`;
}

export function targetOf<K extends DestinationKind>(
  id: string,
  pinned: string,
  kinds: readonly K[],
): { kind: K; target: PublishTarget; secretName: string } | null {
  const [to, ...parts] = id.split(":");
  const secretName = parts.pop();
  const kind = kinds.find((k) => k.kind === to);
  const target = kind && secretName ? kind.fromId(parts.join(":"), pinned) : undefined;
  return kind && target && secretName ? { kind, target, secretName } : null;
}

export function receiptSecretKey(
  receipt: { destinationId: string; account: { pinned: string } },
  kinds: DestinationKinds,
): string {
  const found = targetOf(receipt.destinationId, receipt.account.pinned, kinds);
  return found ? secretKey(found.target, found.secretName, kinds) : receipt.destinationId;
}
