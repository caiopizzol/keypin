import { existsSync, readFileSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import type { Destination, PublishTarget, VaultBackend } from "@keypin/core";
import {
  CloudflareReader,
  currentWranglerToken,
  WorkerSecretDestination,
  wranglerConfigFile,
} from "@keypin/destination-cloudflare";
import { ghToken, GitHubSecretDestination, listRepoSecrets } from "@keypin/destination-github";
import { type Connect, desktopConnect, onePasswordBackend } from "@keypin/vault-1password";
import { cli } from "./cli";
import type { Publisher } from "./deps";
import {
  createFile,
  diskFiles,
  diskLock,
  git,
  isFolder,
  isLink,
  listFolder,
  replaceFile,
} from "./disk";
import { installProblem } from "./install";
import { launch, onSignals } from "./launch";
import { hostTarget, launchedBinary } from "./layout";
import { selfCommand } from "./runtime";
import { selfFor } from "./self";

let vault: VaultBackend | undefined;
let cloudflare: CloudflareReader | undefined;

export function destination(target: PublishTarget, publisher: Publisher): Destination {
  switch (target.to) {
    case "cloudflare-worker":
      return new WorkerSecretDestination({
        account: target.account,
        worker: target.worker,
        ...(publisher.refreshLogins ? {} : { token: () => currentWranglerToken() }),
      });
    case "github-actions":
      return new GitHubSecretDestination({
        repo: target.repo,
        login: publisher.githubLogin,
        refresh: publisher.refreshLogins,
      });
    default: {
      const unknown: never = target;
      throw new Error(`unknown destination ${JSON.stringify(unknown)}`);
    }
  }
}

const connect: Connect = (account) =>
  desktopConnect(account).catch((error: unknown) => {
    const hint = installProblem(error);
    throw hint ? new Error(hint) : error;
  });

async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

declare const KEYPIN_LAUNCHER_SHA256: string | undefined;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function self(cwd: string) {
  const script = process.argv[1] ?? "keypin";
  const target = hostTarget();
  const compiled = Bun.isStandaloneExecutable;
  const launcher = typeof KEYPIN_LAUNCHER_SHA256 === "string" ? KEYPIN_LAUNCHER_SHA256 : null;
  return selfFor({
    full: compiled ? [process.execPath] : selfCommand(process.argv[0] ?? "bun", script),
    running: compiled ? [process.execPath] : [script],
    cwd,
    env: process.env,
    which: (name, path) => Bun.which(name, { PATH: path }),
    real: realPath,
    launches: (path) =>
      compiled && launcher !== null && target !== null
        ? launchedBinary(path, { hash: launcher, target, read: readText, exists: existsSync })
        : null,
  });
}

export function main(): Promise<number> {
  const cwd = process.cwd();
  return cli(process.argv.slice(2), {
    cwd,
    self: self(cwd),
    env: process.env,
    home: homedir(),
    files: diskFiles,
    isFolder,
    listFolder,
    git,
    githubSecrets: (repo, login) => listRepoSecrets({ repo, token: () => ghToken(login) }),
    workerSecrets: (account, worker) =>
      (cloudflare ??= new CloudflareReader({
        token: () => currentWranglerToken(),
      })).listWorkerSecrets(account, worker),
    createFile,
    replaceFile,
    isLink,
    vault: () => (vault ??= onePasswordBackend(connect)),
    now: () => new Date(),
    stdout: process.stdout,
    stderr: process.stderr,
    launch,
    onSignals,
    destination,
    wranglerLoginFile: async () => {
      try {
        const file = wranglerConfigFile();
        await access(file);
        return file;
      } catch {
        return null;
      }
    },
    lock: diskLock,
    isTerminal: Boolean(process.stdin.isTTY),
    ask,
  });
}
