import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import type { Destination, PublishTarget, VaultBackend } from "@keypin/core";
import { WorkerSecretDestination } from "@keypin/destination-cloudflare";
import { GitHubSecretDestination } from "@keypin/destination-github";
import { type Connect, desktopConnect, onePasswordBackend } from "@keypin/vault-1password";
import { cli } from "./cli";
import { createFile, diskFiles, diskLock, isFolder } from "./disk";
import { installProblem } from "./install";
import { launch, onSignals } from "./launch";

let vault: VaultBackend | undefined;

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
    self: process.argv.slice(0, 2),
    env: process.env,
    home: homedir(),
    files: diskFiles,
    isFolder,
    createFile,
    vault: () => (vault ??= onePasswordBackend(connect)),
    now: () => new Date(),
    stdout: process.stdout,
    stderr: process.stderr,
    launch,
    onSignals,
    destination,
    lock: diskLock,
    isTerminal: Boolean(process.stdin.isTTY),
    ask,
  });
}
