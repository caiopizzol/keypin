import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import {
  connectIssuer,
  connectTo,
  type Destination,
  type Fetch,
  type Issuer,
  type IssuerSpec,
  type PublishTarget,
  type Secret,
} from "@keypin/core";
import {
  cloudflareWorker,
  CloudflareReader,
  currentWranglerToken,
  wranglerConfigFile,
} from "@keypin/destination-cloudflare";
import { ghToken, githubActions, listRepoSecrets } from "@keypin/destination-github";
import { resendIssuer } from "@keypin/issuer-resend";
import {
  type Connect,
  desktopConnect,
  onePasswordVault,
  type TokenClient,
  tokenClient,
} from "@keypin/vault-1password";
import { credentialsFrom, infisicalBackend, infisicalVault } from "@keypin/vault-infisical";
import { cli } from "./cli";
import type { Deps, Publisher } from "./deps";
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
import { isStyled } from "./output";
import { selfCommand } from "./runtime";
import { selfFor } from "./self";
import { onePasswordFrom } from "./sign-in";
import { routedVault } from "./vault";

let onePassword: ReturnType<typeof onePasswordFrom> | undefined;
let cloudflare: CloudflareReader | undefined;
let infisical: ReturnType<typeof infisicalBackend> | undefined;

export const destinations = [githubActions, cloudflareWorker];
export const vaults = [infisicalVault, onePasswordVault];

export function destination(target: PublishTarget, publisher: Publisher): Destination {
  return connectTo(destinations, target, publisher);
}

export const issuers = [resendIssuer];

export function issuer(spec: IssuerSpec, admin: Secret, fetch?: Fetch): Issuer {
  return connectIssuer(issuers, spec, admin, fetch);
}

function installed<T>(pending: Promise<T>): Promise<T> {
  return pending.catch((error: unknown) => {
    const hint = installProblem(error);
    throw hint ? new Error(hint) : error;
  });
}

const connect: Connect = (account) => installed(desktopConnect(account));
const token: TokenClient = (value) => installed(tokenClient(value));
const signedIn = () => (onePassword ??= onePasswordFrom(process.env, { desktop: connect, token }));
const vault = routedVault({
  "1password": () => signedIn().vault,
  infisical: () => (infisical ??= infisicalBackend(credentialsFrom(process.env))),
});

async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await prompt.question(question);
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) throw error;
    process.stderr.write("\n");
    return "";
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

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
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
        ? launchedBinary(path, {
            hash: launcher,
            target,
            size: fileSize,
            read: readText,
            exists: existsSync,
          })
        : null,
  });
}

export function main(): Promise<number> {
  return cli(process.argv.slice(2), realDeps());
}

export function realDeps(): Deps {
  const cwd = process.cwd();
  return {
    cwd,
    self: self(cwd),
    env: process.env,
    home: homedir(),
    files: diskFiles,
    isFolder,
    listFolder,
    git,
    githubSecrets: (repo, login, environment) =>
      listRepoSecrets({ repo, environment, token: () => ghToken(login) }),
    workerSecrets: (account, worker) =>
      (cloudflare ??= new CloudflareReader({
        token: () => currentWranglerToken(),
      })).listWorkerSecrets(account, worker),
    createFile,
    replaceFile,
    isLink,
    signIn: () => signedIn().signIn,
    vault: () => vault,
    now: () => new Date(),
    stdout: process.stdout,
    stderr: process.stderr,
    launch,
    onSignals,
    destinations,
    vaults,
    destination,
    issuers,
    issuer,
    wranglerLoginFile: async () => {
      try {
        const file = wranglerConfigFile();
        await access(file);
        return file;
      } catch {
        return null;
      }
    },
    ghLogin: async (login) => {
      if (!Bun.which("gh")) return "not installed";
      return ghToken(login, { refresh: false }).then(
        () => "ok" as const,
        () => "not logged in" as const,
      );
    },
    lock: diskLock,
    isTerminal: Boolean(process.stdin.isTTY),
    styled: {
      stdout: isStyled(process.stdout.isTTY, process.env),
      stderr: isStyled(process.stderr.isTTY, process.env),
    },
    columns: () => process.stderr.columns || 80,
    ask,
  };
}
