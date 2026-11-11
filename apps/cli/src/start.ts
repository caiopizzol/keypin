import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import type { Destination, RotateSpec, PublishTarget, Secret, VaultBackend } from "@keypin/core";
import {
  CloudflareReader,
  currentWranglerToken,
  WorkerSecretDestination,
} from "@keypin/destination-cloudflare";
import { ghToken, GitHubSecretDestination, listRepoSecrets } from "@keypin/destination-github";
import { CloudflareAccountTokens } from "@keypin/provider-cloudflare";
import { type Connect, desktopConnect, onePasswordBackend } from "@keypin/vault-1password";
import { cli } from "./cli";
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
import { selfCommand } from "./runtime";

let vault: VaultBackend | undefined;
let cloudflare: CloudflareReader | undefined;

function destination(target: PublishTarget): Destination {
  switch (target.to) {
    case "cloudflare-worker":
      return new WorkerSecretDestination({ account: target.account, worker: target.worker });
    case "github-actions":
      return new GitHubSecretDestination({ repo: target.repo, account: target.account });
    default: {
      const unknown: never = target;
      throw new Error(`unknown destination ${JSON.stringify(unknown)}`);
    }
  }
}

function provider(spec: RotateSpec, admin: Secret) {
  switch (spec.provider) {
    case "cloudflare-account-token":
      return new CloudflareAccountTokens({ account: spec.account, admin });
    default: {
      const unknown: never = spec.provider;
      throw new Error(`unknown provider ${JSON.stringify(unknown)}`);
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

export function main(): Promise<number> {
  return cli(process.argv.slice(2), {
    cwd: process.cwd(),
    self: selfCommand(process.argv[0] ?? "bun", process.argv[1] ?? "keypin"),
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
    provider,
    lock: diskLock,
    isTerminal: Boolean(process.stdin.isTTY),
    ask,
  });
}
