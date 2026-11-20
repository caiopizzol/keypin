import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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
  signInVariables,
} from "@keypin/core";
import {
  awsIssuer,
  awsSignIn,
  secretsManagerBackend,
  secretsManagerVault,
} from "@keypin/connectors/aws";
import {
  cloudflareIssuer,
  cloudflareWorker,
  CloudflareReader,
  type CloudflareSignIn,
  cloudflareSignIn,
} from "@keypin/connectors/cloudflare";
import { convexDeployment } from "@keypin/connectors/convex";
import { elevenlabsIssuer } from "@keypin/connectors/elevenlabs";
import { flyApp } from "@keypin/connectors/fly";
import {
  ghToken,
  githubActions,
  githubIdToken,
  githubPull,
  listRepoSecrets,
  maskInLog,
  sshHostname,
} from "@keypin/connectors/github";
import { gitlabGroup, gitlabProject } from "@keypin/connectors/gitlab";
import { googleIssuer, googleServiceAccountIssuer } from "@keypin/connectors/google";
import { atlasIssuer } from "@keypin/connectors/mongodb-atlas";
import { neonIssuer } from "@keypin/connectors/neon";
import { netlifyProject } from "@keypin/connectors/netlify";
import { openaiIssuer } from "@keypin/connectors/openai";
import { openrouterIssuer } from "@keypin/connectors/openrouter";
import { railwayService } from "@keypin/connectors/railway";
import { resendIssuer } from "@keypin/connectors/resend";
import { sendgridIssuer } from "@keypin/connectors/sendgrid";
import { supabaseFunctions, supabaseIssuer } from "@keypin/connectors/supabase";
import { twilioIssuer } from "@keypin/connectors/twilio";
import { vercelProject } from "@keypin/connectors/vercel";
import { xaiIssuer } from "@keypin/connectors/xai";
import { randomIssuer } from "./random";
import {
  type Connect,
  desktopConnect,
  onePasswordVault,
  type TokenClient,
  tokenClient,
} from "@keypin/connectors/onepassword";
import { credentialsFrom, infisicalBackend, infisicalVault } from "@keypin/connectors/infisical";
import { accessTokenFrom, bitwardenBackend, bitwardenVault } from "@keypin/connectors/bitwarden";
import {
  credentialsFrom as dopplerCredentials,
  dopplerBackend,
  dopplerVault,
} from "@keypin/connectors/doppler";
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
const cloudflareLogins = new Map<string, CloudflareSignIn>();
const cloudflareReaders = new Map<string, CloudflareReader>();
let infisical: ReturnType<typeof infisicalBackend> | undefined;
let bitwarden: ReturnType<typeof bitwardenBackend> | undefined;
let doppler: ReturnType<typeof dopplerBackend> | undefined;
let secretsManager: ReturnType<typeof secretsManagerBackend> | undefined;

export const destinations = [
  githubActions,
  cloudflareWorker,
  vercelProject,
  supabaseFunctions,
  netlifyProject,
  railwayService,
  convexDeployment,
  flyApp,
  gitlabProject,
  gitlabGroup,
];
export const vaults = [
  infisicalVault,
  bitwardenVault,
  dopplerVault,
  secretsManagerVault,
  onePasswordVault,
];
export const pulls = [githubPull];
export const signInNames = signInVariables([...vaults, ...destinations]);

export function destination(target: PublishTarget, publisher: Publisher): Destination {
  return connectTo<Publisher>(destinations, target, publisher);
}

export const issuers = [
  resendIssuer,
  neonIssuer,
  openaiIssuer,
  supabaseIssuer,
  cloudflareIssuer,
  openrouterIssuer,
  googleIssuer,
  googleServiceAccountIssuer,
  elevenlabsIssuer,
  awsIssuer,
  sendgridIssuer,
  twilioIssuer,
  xaiIssuer,
  atlasIssuer,
  randomIssuer,
];

export function issuer(spec: IssuerSpec, admin: Secret | null, fetch?: Fetch): Issuer {
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
function workerSignIn(folder: string): CloudflareSignIn {
  const known = cloudflareLogins.get(folder);
  if (known) return known;
  const made = cloudflareSignIn({ env: process.env, signIn: signInNames, folder });
  cloudflareLogins.set(folder, made);
  return made;
}

function workerReader(folder: string): CloudflareReader {
  const known = cloudflareReaders.get(folder);
  if (known) return known;
  const made = new CloudflareReader({ token: () => workerSignIn(folder).token() });
  cloudflareReaders.set(folder, made);
  return made;
}

const vault = routedVault({
  "1password": () => signedIn().vault,
  infisical: () =>
    (infisical ??= infisicalBackend(credentialsFrom(process.env), globalThis.fetch, {
      idToken: githubIdToken(process.env, globalThis.fetch),
      warn: (text) => process.stderr.write(`keypin: warning: ${text}\n`),
    })),
  bitwarden: () => (bitwarden ??= bitwardenBackend(accessTokenFrom(process.env))),
  doppler: () =>
    (doppler ??= dopplerBackend(dopplerCredentials(process.env), globalThis.fetch, {
      idToken: githubIdToken(process.env, globalThis.fetch),
      warn: (text) => process.stderr.write(`keypin: warning: ${text}\n`),
    })),
  awssm: () =>
    (secretsManager ??= secretsManagerBackend(awsSignIn(process.env, homedir(), readText), {
      idToken: githubIdToken(process.env, globalThis.fetch),
    })),
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
    git: (folder, args) => git(folder, args, signInNames),
    githubSecrets: (repo, login, environment) =>
      listRepoSecrets({ repo, environment, token: () => ghToken(login, { signIn: signInNames }) }),
    organizationSecrets: (repo, login) =>
      listRepoSecrets({
        repo,
        organization: true,
        token: () => ghToken(login, { signIn: signInNames }),
      }),
    sshHostname: (destination) => sshHostname(destination, signInNames),
    workerSecrets: (folder, account, worker) =>
      workerReader(folder).listWorkerSecrets(account, worker),
    createFile,
    replaceFile,
    isLink,
    signIn: () => signedIn().signIn,
    vault: () => vault,
    now: () => new Date(),
    tag: () => crypto.randomUUID().slice(0, 6),
    stdout: process.stdout,
    stderr: process.stderr,
    launch,
    onSignals,
    destinations,
    vaults,
    destination,
    issuers,
    issuer,
    pulls,
    workerSignIn,
    ghLogin: async (login) => {
      if (!Bun.which("gh")) return "not installed";
      return ghToken(login, { refresh: false, signIn: signInNames }).then(
        () => "ok" as const,
        () => "not logged in" as const,
      );
    },
    lock: diskLock,
    isTerminal: Boolean(process.stdin.isTTY),
    warnRunner: (title, text) => {
      if (process.env.GITHUB_ACTIONS !== "true") return false;
      process.stdout.write(`::warning title=${title}::${text}\n`);
      return true;
    },
    maskInLog: (values) => maskInLog(process.env, values, process.stderr),
    styled: {
      stdout: isStyled(process.stdout.isTTY, process.env),
      stderr: isStyled(process.stderr.isTTY, process.env),
    },
    columns: () => process.stderr.columns || 80,
    ask,
  };
}
