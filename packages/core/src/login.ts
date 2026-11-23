import type { KeyRef, SignInReason } from "./contracts";
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
  readonly provider: string;
}

export interface SecretspecAt {
  readonly uri: string;
  readonly project: string;
  readonly profile: string;
  readonly key: string;
  readonly ref: Readonly<Record<string, unknown>> | null;
}

export interface SecretspecProvider<R extends KeyRef = KeyRef> {
  readonly provider: string;
  readonly refuses?: ReadonlyMap<string, string>;
  locate?(at: SecretspecAt): R | string;
}

export interface VaultRules<R extends KeyRef = KeyRef, U extends KeyRef = KeyRef> {
  readonly kind: R["kind"];
  readonly name: string;
  readonly scheme: string;
  readonly placeholder: string;
  parse(rest: string): U | string;
  pinned(reference: U, like: R): R;
  format(ref: R): string;
  account(ref: R): string;
  accounts?(refs: readonly R[]): readonly string[];
  sameItem(a: R, b: R): boolean;
  sameField?(a: R, b: R): boolean;
  mayShareField?(a: R, b: R): boolean;
  describe?(ref: R): string;
  stored(value: Readonly<Record<string, unknown>>): R | null;
  readonly newKeys?: NewKeys;
  readonly secretspec?: SecretspecProvider<R>;
}

export interface VaultKind<
  H = unknown,
  R extends KeyRef = KeyRef,
  U extends KeyRef = KeyRef,
> extends VaultRules<R, U> {
  readonly newValueByHand: string;
  readonly addRotatedDate: string;
  readonly keepsRotated?: false;
  readonly holdsWrites?: boolean;
  readonly signInVariables?: readonly string[];
  readonly oidcVariables?: readonly string[];
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
