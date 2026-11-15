import type { KeyRef, SignInReason } from "./contracts";
import type { ProjectScan } from "./gaps";

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
  readonly scan: ProjectScan;
  readonly files: {
    readonly env: readonly string[];
    readonly wrangler: readonly string[];
    readonly workflows: readonly string[];
  };
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

export interface VaultKind<H = unknown> {
  readonly kind: KeyRef["kind"];
  signInNotes?(host: H): readonly string[];
  itemNotes?(refs: readonly KeyRef[], host: H): readonly string[];
  prerequisites?(use: VaultUse, host: H): readonly Prerequisite[];
}

export function sentence(text: string): string {
  const first = /^(?!keypin\b|gh\b|wrangler\b)[a-z]+\b(?![./:])/.test(text)
    ? `${text[0]?.toUpperCase()}${text.slice(1)}`
    : text;
  return /[.:]$/.test(first) ? first : `${first}.`;
}
