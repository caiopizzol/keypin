import type {
  Destination,
  Files,
  IssueSpec,
  PublishTarget,
  Secret,
  TokenProvider,
  VaultBackend,
} from "@keypin/core";

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
  pid: number | null;
  running: boolean | null;
}

export type Lock = (
  path: string,
) => Promise<{ held: true; lock: HeldLock } | { held: false; holder: LockHolder }>;

export type CreateFile = (path: string, text: string) => Promise<"created" | "exists" | "link">;

export interface Writer {
  write(text: string): void;
}

export interface Deps {
  cwd: string;
  self: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  files: Files;
  isFolder(path: string): Promise<boolean>;
  createFile: CreateFile;
  vault(): VaultBackend;
  now(): Date;
  stdout: Writer;
  stderr: Writer;
  launch: Launch;
  onSignals: OnSignals;
  destination(target: PublishTarget): Destination;
  provider(issue: IssueSpec, admin: Secret): TokenProvider;
  lock: Lock;
  isTerminal: boolean;
  ask(question: string): Promise<string>;
}

export class UsageError extends Error {}

export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
