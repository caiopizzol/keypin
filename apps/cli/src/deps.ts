import type {
  Destination,
  DestinationKind,
  Files,
  Issuer,
  IssuerKinds,
  IssuerSpec,
  PublishTarget,
  PullKinds,
  Secret,
  StoreRead,
  VaultBackend,
  VaultKind,
} from "@keypin/core";
import type { Self } from "./self";
import type { SignIn } from "./sign-in";

export interface Child {
  exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

export type Launch = (command: string[], env: Record<string, string>) => Child;

export type OnSignals = (handler: (signal: NodeJS.Signals) => void) => () => void;

export interface HeldLock {
  release(): Promise<void>;
}

export interface LockHolder {
  file: string;
  pid: number | null;
  running: boolean | null;
}

export type Lock = (
  path: string,
) => Promise<{ held: true; lock: HeldLock } | { held: false; holder: LockHolder }>;

export type CreateFile = (path: string, text: string) => Promise<"created" | "exists" | "link">;

export type ReplaceFile = (
  path: string,
  expected: string,
  text: string,
) => Promise<"replaced" | "changed" | "link">;

export interface FolderEntry {
  name: string;
  kind: "file" | "folder" | "other";
}

export interface Writer {
  write(text: string): void;
}

export interface Deps {
  cwd: string;
  self: Self;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  files: Files;
  isFolder(path: string): Promise<boolean>;
  listFolder(path: string): Promise<FolderEntry[]>;
  git(folder: string, args: readonly string[]): Promise<string | null>;
  githubSecrets(repo: string, login: string | null, environment?: string): Promise<StoreRead>;
  organizationSecrets(repo: string, login: string | null): Promise<StoreRead>;
  sshHostname(destination: string): Promise<string | null>;
  workerSecrets(folder: string, account: string, worker: string): Promise<StoreRead>;
  createFile: CreateFile;
  replaceFile: ReplaceFile;
  isLink(path: string): Promise<boolean>;
  signIn(): SignIn;
  vault(): VaultBackend;
  now(): Date;
  tag(): string;
  stdout: Writer;
  stderr: Writer;
  launch: Launch;
  onSignals: OnSignals;
  destinations: readonly DestinationKind<PublishTarget, Publisher, Deps>[];
  vaults: readonly VaultKind<VaultHost>[];
  destination(target: PublishTarget, publisher: Publisher): Destination;
  issuers: IssuerKinds;
  issuer(spec: IssuerSpec, admin: Secret | null): Issuer;
  pulls: PullKinds;
  workerSignIn(folder: string): WorkerSignIn;
  ghLogin(login: string | null): Promise<"ok" | "not installed" | "not logged in">;
  lock: Lock;
  isTerminal: boolean;
  warnRunner(title: string, text: string): boolean;
  maskInLog(values: readonly string[]): Promise<void>;
  styled: { stdout: boolean; stderr: boolean };
  columns: () => number;
  ask(question: string): Promise<string>;
}

export interface VaultHost {
  readonly signIn: SignIn | null;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface Publisher {
  githubLogin: string | null;
  refreshLogins: boolean;
  signInVariables: readonly string[];
  signInEnv: Readonly<Record<string, string | undefined>>;
  workerSignIn: WorkerSignIn | null;
}

export interface WorkerSignIn {
  readonly via: "oauth" | "api-token";
  token(): Promise<string>;
}

export class UsageError extends Error {}
