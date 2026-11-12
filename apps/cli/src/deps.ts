import type { Destination, Files, PublishTarget, StoreRead, VaultBackend } from "@keypin/core";
import type { Self } from "./self";

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
  githubSecrets(repo: string, login: string | null): Promise<StoreRead>;
  workerSecrets(account: string, worker: string): Promise<StoreRead>;
  createFile: CreateFile;
  replaceFile: ReplaceFile;
  isLink(path: string): Promise<boolean>;
  vault(): VaultBackend;
  now(): Date;
  stdout: Writer;
  stderr: Writer;
  launch: Launch;
  onSignals: OnSignals;
  destination(target: PublishTarget, publisher: Publisher): Destination;
  wranglerLoginFile(): Promise<string | null>;
  lock: Lock;
  isTerminal: boolean;
  ask(question: string): Promise<string>;
}

export interface Publisher {
  githubLogin: string | null;
  refreshLogins: boolean;
}

export class UsageError extends Error {}

export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
