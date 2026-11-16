import type { KeyRef, SignInReason } from "./contracts";
import type { TableReader } from "./destination";
import type { KeysMap } from "./map";

export type PrerequisiteStatus =
  | "not installed"
  | "not logged in"
  | "not checked"
  | "sign-in failed";

export interface Prerequisite {
  readonly name: string;
  readonly status: PrerequisiteStatus;
  readonly fix: string;
  readonly title: string;
  readonly body: readonly string[];
  readonly coversFailures: boolean;
}

export interface LoginProject<T> {
  readonly folder: string;
  readonly targets: readonly T[];
  readonly used: boolean;
}

export interface PublisherPart<P> {
  readonly fields: Partial<P>;
  readonly notes?: readonly string[];
}

export interface VaultUse {
  readonly items: number;
  readonly allItems: number;
  readonly failures: readonly SignInReason[];
}

export interface NewKeys {
  readonly reference: string;
  readonly pin: Readonly<Record<string, string>>;
  readonly options: string;
}

export interface VaultKind<
  H = unknown,
  R extends KeyRef = KeyRef,
  U extends KeyRef = KeyRef,
  P = unknown,
> {
  readonly kind: R["kind"];
  readonly name: string;
  readonly scheme: string;
  readonly placeholder: string;
  readonly needsPin: string;
  readPin(read: TableReader): P | undefined;
  parse(rest: string): U | string;
  pinned(reference: U, pin: P): R;
  format(ref: R): string;
  account(ref: R): string;
  accounts?(refs: readonly R[]): readonly string[];
  sameItem(a: R, b: R): boolean;
  sameField?(a: R, b: R): boolean;
  stored(value: Readonly<Record<string, unknown>>): R | null;
  readonly newKeys?: NewKeys;
  readonly signInVariables?: readonly string[];
  addByHand?(map: KeysMap): string | undefined;
  signInNotes?(host: H): readonly string[];
  itemNotes?(refs: readonly KeyRef[], host: H): readonly string[];
  prerequisites?(use: VaultUse, host: H): readonly Prerequisite[];
}

export type VaultKinds = readonly VaultKind[];

export function sentence(text: string): string {
  const first = /^(?!keypin\b|gh\b|wrangler\b)[a-z]+\b(?![./:])/.test(text)
    ? `${text[0]?.toUpperCase()}${text.slice(1)}`
    : text;
  return /[.:]$/.test(first) ? first : `${first}.`;
}
